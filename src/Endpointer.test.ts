import { describe, expect, test } from "bun:test"
import { defaults, Endpointer, type Event } from "./Endpointer.ts"

/** Feeds one frame per probability; each frame holds its index so the utterance can be checked. */
const feed = (probabilities: ReadonlyArray<number>, endpointer = new Endpointer()) => {
  const events: Array<{ readonly at: number; readonly event: Event }> = []
  probabilities.forEach((probability, at) => {
    const event = endpointer.push(new Float32Array([at]), probability)
    if (event !== undefined) events.push({ at, event })
  })
  return events
}

const quiet = (frames: number) => Array<number>(frames).fill(0)
const voiced = (frames: number) => Array<number>(frames).fill(0.9)

describe("Endpointer", () => {
  test("reacts on the first voiced frame and confirms after a few", () => {
    const events = feed([...quiet(3), ...voiced(defaults.confirm)])
    expect(events.map(({ at, event }) => [at, event._tag])).toEqual([
      [3, "Onset"],
      [3 + defaults.confirm - 1, "Speech"],
    ])
  })

  test("waits a little longer to confirm what may be yapd's own voice, judged as it begins", () => {
    const endpointer = new Endpointer()
    const events: Array<readonly [number, string]> = []
    const frames = [...quiet(3), ...voiced(defaults.wary), ...quiet(defaults.silence)]
    frames.forEach((probability, at) => {
      // Only its first frame tells.
      const event = endpointer.push(new Float32Array(512), probability, at === 3 ? "wary" : "plain")
      if (event !== undefined) events.push([at, event._tag])
    })
    expect(defaults.wary).toBeGreaterThan(defaults.confirm)
    expect(events.slice(0, 2)).toEqual([
      [3, "Onset"],
      [3 + defaults.wary - 1, "Speech"],
    ])
  })

  test("waits longer still once yapd's own voice has stopped it for nothing, letting go what ends short of that", () => {
    const endpointer = new Endpointer()
    const events: Array<readonly [number, string]> = []
    const frames = [...voiced(defaults.capped - 1), ...quiet(defaults.abandon), ...voiced(defaults.capped)]
    frames.forEach((probability, at) => {
      const event = endpointer.push(new Float32Array(512), probability, "capped")
      if (event !== undefined) events.push([at, event._tag])
    })
    expect(defaults.capped).toBeGreaterThan(defaults.wary)
    const again = defaults.capped - 1 + defaults.abandon
    expect(events).toEqual([
      [0, "Onset"],
      [again - 1, "Abandoned"],
      [again, "Onset"],
      [again + defaults.capped - 1, "Speech"],
    ])
  })

  test("lets a short noise go", () => {
    const events = feed([...voiced(2), ...quiet(defaults.abandon)])
    expect(events.map(({ event }) => event._tag)).toEqual(["Onset", "Abandoned"])
  })

  test("keeps the lead-in after a noise it let go, so speech that starts just after it isn't clipped", () => {
    const events = feed([...quiet(3), ...voiced(2), ...quiet(defaults.abandon), ...voiced(10), ...quiet(defaults.silence)])
    const last = events.at(-1)?.event
    const audio = last?._tag === "Utterance" ? [...last.audio] : []
    const began = 5 + defaults.abandon
    expect(audio[0]).toBe(began - defaults.lead)
  })

  test("ends the utterance after enough silence, keeping the lead-in", () => {
    const events = feed([...quiet(20), ...voiced(10), ...quiet(defaults.silence)])
    const last = events.at(-1)?.event
    expect(last?._tag).toBe("Utterance")
    const audio = last?._tag === "Utterance" ? [...last.audio] : []
    expect(audio[0]).toBe(20 - defaults.lead)
    expect(audio.at(-1)).toBe(29 + defaults.tail)
  })

  test("waits out a pause between words", () => {
    const events = feed([...voiced(10), ...quiet(defaults.silence - 1), ...voiced(5)])
    expect(events.map(({ event }) => event._tag)).toEqual(["Onset", "Speech"])
  })

  test("doesn't end on frames that are only a little less sure", () => {
    const events = feed([...voiced(10), ...Array<number>(defaults.silence * 2).fill(0.4)])
    expect(events.map(({ event }) => event._tag)).toEqual(["Onset", "Speech"])
  })

  test("counts wavering frames once silence has started", () => {
    const events = feed([...voiced(10), 0, ...Array<number>(defaults.silence).fill(0.4)])
    expect(events.at(-1)?.event._tag).toBe("Utterance")
  })

  test("cuts off an utterance that goes on too long", () => {
    const events = feed(voiced(defaults.longest))
    expect(events.at(-1)?.event._tag).toBe("Utterance")
  })

  test("listens again after an utterance", () => {
    const endpointer = new Endpointer()
    feed([...voiced(10), ...quiet(defaults.silence)], endpointer)
    expect(feed(voiced(1), endpointer).map(({ event }) => event._tag)).toEqual(["Onset"])
  })
})
