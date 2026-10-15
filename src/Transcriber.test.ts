import { describe, expect, test } from "bun:test"
import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers"
import { Effect } from "effect"
import { glossary, heard, once, transcribe } from "./Transcriber.ts"

/** Whisper hearing "Ghostnet.", after the glossary it was told, which is kept, one for each time it's told one. */
const whisper = (told: Array<string>) => {
  let last = ""
  const asr = Object.assign(
    (_audio: Float32Array, options: object) => {
      const prompted = "decoder_input_ids" in options
      if (prompted) told.push(last)
      return Promise.resolve({ text: `${prompted ? last : ""} Ghostnet.` })
    },
    {
      tokenizer: {
        encode: (text: string) => {
          last = text
          return Array.from(text, () => 0)
        },
        convert_tokens_to_ids: () => [1],
      },
      model: { generation_config: {}, _retrieve_init_tokens: () => [2] },
    },
  )
  return asr as unknown as AutomaticSpeechRecognitionPipeline
}

describe("Transcriber", () => {
  test("tells Whisper the words to listen for, and leaves names out before the worktree ones when it's too long", () => {
    expect(glossary(["rig", "free-sound", " ", "rig"])).toBe(" Glossary: worktree, no worktree, in a worktree, rig, free-sound.")
    expect(glossary(["rig", "free-sound", "yapd"], (text) => text.length < 60)).toBe(" Glossary: worktree, no worktree, in a worktree, rig.")
    expect(glossary(["rig"], () => false)).toBe(" Glossary: worktree, no worktree, in a worktree.")
  })

  test("listens for the terms it's given, like a question's options, in place of what dictation expects, and for that when given none", async () => {
    const told: Array<string> = []
    const hear = transcribe(Effect.succeed(whisper(told)), "en", "1 second", () => ["rig"])
    const audio = new Float32Array(16)
    const heard = await Effect.runPromise(Effect.all([hear(audio, ["Mainnet", "Ghostnet"]), hear(audio, []), hear(audio)]))
    expect(heard).toEqual(["Ghostnet.", "Ghostnet.", "Ghostnet."])
    expect(told).toEqual([
      " Glossary: worktree, no worktree, in a worktree, Mainnet, Ghostnet.",
      " Glossary: worktree, no worktree, in a worktree, rig.",
      " Glossary: worktree, no worktree, in a worktree, rig.",
    ])
  })

  test("never passes the glossary on as something the user said", () => {
    const told = glossary(["yapd"])
    expect(heard(`${told} In yapd, fix it, no worktree.`, told)).toBe(" In yapd, fix it, no worktree.")
    // Given back changed, there's no telling where it ends, so it's heard again without.
    expect(heard(" Glossary: worktree, no work tree. In yapd, fix it.", told)).toBeUndefined()
  })

  test("tries again to load a model that didn't, and keeps the one that did", async () => {
    let loads = 0
    const tried = await Effect.gen(function* () {
      const model = yield* once(Effect.suspend(() => (++loads === 1 ? Effect.fail("offline") : Effect.succeed(`model ${loads}`))))
      return [yield* Effect.either(model), yield* Effect.either(model), yield* Effect.either(model)].map((tried) => tried._tag)
    }).pipe(Effect.scoped, Effect.runPromise)
    expect(tried).toEqual(["Left", "Right", "Right"])
    expect(loads).toBe(2)
  })
})
