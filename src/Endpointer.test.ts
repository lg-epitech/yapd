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
      const event = endpointer.push(new Float32Array(512), probability, at === 3)
      if (event !== undefined) events.push([at, event._tag])
    })
    expect(defaults.wary).toBeGreaterThan(defaults.confirm)
    expect(events.slice(0, 2)).toEqual([
      [3, "Onset"],
      [3 + defaults.wary - 1, "Speech"],
    ])
  })

  test("lets a short noise go", () => {
    const events = feed([...voiced(2), ...quiet(defaults.abandon)])
    expect(events.map(({ event }) => event._tag)).toEqual(["Onset", "Abandoned"])
  })

  test("keeps the lead-in after what may have been yapd's own voice it let go, so speech that starts just after it isn't clipped", () => {
    const endpointer = new Endpointer()
    const frames = [...quiet(3), ...voiced(2), ...quiet(defaults.abandon), ...voiced(10), ...quiet(defaults.silence)]
    const events = frames.map((probability, at) => endpointer.push(new Float32Array([at]), probability, at === 3))
    const last = events.findLast((event) => event !== undefined)
    const audio = last?._tag === "Utterance" ? [...last.audio] : []
    const began = 5 + defaults.abandon
    expect(audio[0]).toBe(began - defaults.lead)
  })

  test("starts the lead-in afresh after any other noise it let go, as before", () => {
    const events = feed([...quiet(3), ...voiced(2), ...quiet(defaults.abandon), ...voiced(10), ...quiet(defaults.silence)])
    const last = events.at(-1)?.event
    const audio = last?._tag === "Utterance" ? [...last.audio] : []
    expect(audio[0]).toBe(5 + defaults.abandon)
  })

  test("ends the utterance after enough silence, keeping the lead-in", () => {
    const events = feed([...quiet(20), ...voiced(10), ...quiet(defaults.silence)])
    const last = events.at(-1)?.event
    expect(last?._tag).toBe("Utterance")
    const audio = last?._tag === "Utterance" ? [...last.audio] : []
    expect(audio[0]).toBe(20 - defaults.lead)
    expect(audio.at(-1)).toBe(29 + defaults.tail)
  })

  test("the audio at a pause is the utterance's, sample for sample, when nothing voiced follows; a voiced frame after it resumes, and the utterance holds all of it", () => {
    const samples = (event: Event | undefined) => (event?._tag === "Pause" || event?._tag === "Utterance" ? [...event.audio] : [])
    const stopped = feed([...quiet(20), ...voiced(10), ...quiet(defaults.silence)])
    expect(stopped.map(({ at, event }) => [at, event._tag])).toEqual([
      [20, "Onset"],
      [20 + defaults.confirm - 1, "Speech"],
      [29 + defaults.pause, "Pause"],
      [29 + defaults.silence, "Utterance"],
    ])
    const [, , pause, utterance] = stopped.map(({ event }) => event)
    expect(samples(pause)).toEqual(samples(utterance))
    expect(utterance).toMatchObject({ paused: true })
    const resumed = feed([...quiet(20), ...voiced(10), ...quiet(defaults.pause), ...voiced(5), ...quiet(defaults.silence)])
    expect(resumed.map(({ event }) => event._tag)).toEqual(["Onset", "Speech", "Pause", "Resumed", "Pause", "Utterance"])
    const last = resumed.at(-1)?.event
    expect(samples(last)).toEqual(samples(resumed.at(-2)?.event))
    expect(samples(last)[0]).toBe(20 - defaults.lead)
    expect(samples(last).at(-1)).toBe(29 + defaults.pause + 5 + defaults.tail)
    // Cut off for going on too long, it isn't what any pause heard.
    expect(feed(voiced(defaults.longest)).at(-1)?.event).toMatchObject({ _tag: "Utterance", paused: false })
  })

  test("waits out a pause between words", () => {
    const events = feed([...voiced(10), ...quiet(defaults.silence - 1), ...voiced(5)])
    expect(events.map(({ event }) => event._tag)).toEqual(["Onset", "Speech", "Pause", "Resumed"])
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
