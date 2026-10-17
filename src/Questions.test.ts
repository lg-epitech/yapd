import { describe, expect, test } from "bun:test"
import { Either, Option } from "effect"
import * as Persona from "./Persona.ts"
import * as Questions from "./Questions.ts"

const lines = { ...Persona.plain, address: "sir" }

/** A part as T3 Code shows it: one pick from what's given, which takes his own words too, unless `more` says otherwise. */
const question = (asked: string, options: ReadonlyArray<string | { readonly label: string; readonly description: string }>, more: Partial<Questions.Question> = {}): Questions.Question => ({
  id: asked,
  header: "",
  question: asked,
  options: options.map((option) => (typeof option === "string" ? { label: option, description: "" } : option)),
  multiSelect: false,
  allowCustomAnswer: true,
  required: true,
  ...more,
})

/** A part as it's said, in the agent's own words when they can be. */
const part = (asked: string, options: ReadonlyArray<string | { readonly label: string; readonly description: string }>, more: Partial<Questions.Question> = {}) =>
  Questions.said(question(asked, options, more), Questions.sayQuestion(asked))

/** How each part of a question about the Tezos migration is put to him, which is asked. */
const wording = (...parts: ReadonlyArray<Questions.Said>) => {
  const worded = Questions.worded({ called: "the Tezos migration", parts, lines })
  if (worded._tag !== "Ask") throw new Error(`Only told: ${Option.getOrElse(worded.spoken, () => "")}`)
  return worded.parts
}

describe("Questions", () => {
  test("a question is read in its own words when they can be said, and left to the model when they can't", () => {
    expect(Questions.sayQuestion("  Which library should we use   for `date` formatting?")).toEqual(Option.some("Which library should we use for date formatting?"))
    expect(Questions.sayQuestion(`Should the "staging" config win, e.g. for tests & CI?`)).toEqual(Option.some("Should the staging config win, for example for tests and CI?"))
    // The work is never put down to an agent.
    expect(Questions.sayQuestion("Should the Claude agent also run the linter?")).toEqual(Option.some("Should the work also run the linter?"))
    for (const unsayable of [
      "Should I update src/config/loader.ts as well?",
      "Can I push to t3/jarvis-m3 now?",
      "Is https://github.com/x/y/pull/412 the right PR?",
      "Use `FEE_TABLE_V2` or the old one?",
      "Should I keep the {debug} flag…",
      "Quelle base de données préférez-vous pour les tests?",
      "Should I cherry-pick 4f2a9c81e7b3 onto main?",
      "Is 2d5cee5c-6a1f-4b7e-9d3c-1f0e8a7b6c5d the right request?",
      `Which of these should I do first, given that ${"the migration ".repeat(11)}is late?`,
    ]) {
      expect([unsayable, Questions.sayQuestion(unsayable)]).toEqual([unsayable, Option.none()])
    }
  })

  test("options are said as they read: '(Recommended)' becomes yapd's pick, code and quotes go, and one that can't be said goes by its description or its number", () => {
    expect(Questions.sayLabel("Blue (Recommended)", 1, "")).toEqual({ said: "Blue", recommended: true, by: "label" })
    expect(Questions.sayLabel("Blue [recommended]", 1, "")).toEqual({ said: "Blue", recommended: true, by: "label" })
    expect(Questions.sayLabel("Blue - Recommended", 1, "")).toEqual({ said: "Blue", recommended: true, by: "label" })
    expect(Questions.sayLabel("`date-fns`", 0, "")).toEqual({ said: "date-fns", recommended: false, by: "label" })
    expect(Questions.sayLabel(`"main".`, 0, "")).toEqual({ said: "main", recommended: false, by: "label" })
    // What looks like one of yapd's handles is the agent's own.
    expect(Questions.sayLabel("t3.small", 0, "")).toEqual({ said: "t3.small", recommended: false, by: "label" })
    expect(Questions.sayLabel("src/utils/date.ts", 1, "Keep the helper we wrote. It's tested.")).toEqual({ said: "option two, keep the helper we wrote", recommended: false, by: "meaning" })
    expect(Questions.sayLabel("~/code/fees.json (Recommended)", 2, "Read the fee table from the JSON file the exporter writes on every run of the nightly job.")).toEqual({
      said: "option three",
      recommended: true,
      by: "number",
    })
  })

  test("he'd begun hearing yapd's pick once some of it was said before what wasn't, or when how far it got can't be told", () => {
    const force = part("Shall I force-push to fix the history?", ["Force-push", "Leave it (Recommended)"])
    const asking = wording(force)[0]!
    const heard = (unsaid: string, line = asking.first) => Questions.heardPick(force, line, unsaid)
    // Begun: some or all of it said.
    expect(heard("Leave it.")).toBe(true)
    expect(heard("it.")).toBe(true)
    expect(heard("Which one, sir?", asking.more)).toBe(true)
    // Not begun: all of it, and maybe more, still to say.
    expect(heard("I'd go with Leave it.")).toBe(false)
    expect(heard("Force-push or Leave it? I'd go with Leave it.")).toBe(false)
    expect(heard("history? Force-push or Leave it? I'd go with Leave it.")).toBe(false)
    // Not knowing how far it got, it's taken as heard; with no pick in the line, as asked which one then without it, there's none to hear.
    expect(heard("something it never said.")).toBe(true)
    expect(heard("Leave it?", "Force-push or Leave it?")).toBe(false)
    const shade = part("Which shade should the badge use?", ["Red", "Blue"])
    expect(Questions.heardPick(shade, wording(shade)[0]!.first, "Blue?")).toBe(false)
  })

  test("an answer is taken without the model only when it's exactly an option's name, in any case and without a full stop after it: anything else is the model's", () => {
    const networks = part("Which network should we start with?", ["Mainnet", "Ghostnet (Recommended)", "Full history", "Shadow testnet"])
    const pick = (heard: string, inFull = true) => Questions.pick(networks, heard, { inFull, parts: 1 })
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    for (const [heard, index] of [
      ["Mainnet.", 0],
      ["MAINNET!", 0],
      ["  Full   history? ", 2],
      // Its "(Recommended)" only marks yapd's pick: the name is the same with it or without.
      ["Ghostnet.", 1],
      ["Ghostnet (Recommended)", 1],
      // Nothing else goes without saying: no "the", "please", "sir" or "uh", no second stop, nor any other mark.
      ["The full history.", undefined],
      ["Mainnet..", undefined],
      // Nor how it sounds, part of it, or more than it.
      ["ghost net", undefined],
      ["Ghostnet, but only for the tests.", undefined],
      // Nor a place, a number or a letter.
      ["The third one.", undefined],
      // Nor a plain yes or no, what points at yapd's pick, or leaving it to yapd: the model's told the pick, and whether he heard it.
      ["Yes.", undefined],
      ["Your pick.", undefined],
    ] as const) {
      expect([heard, pick(heard)]).toEqual([heard, index === undefined ? undefined : picked(index)])
    }
    // Cut off before yapd said its pick, a yes or a no is the model's too, and an option's name is still that option.
    expect([pick("Yes.", false), pick("No.", false), pick("Mainnet.", false)]).toEqual([undefined, undefined, picked(0)])
    // Two options named alike are the model's to tell apart.
    expect(Questions.pick(part("Which plan?", ["Plan A", "plan  a"]), "Plan A.", { inFull: true, parts: 1 })).toBeUndefined()
    // With no option that says none, "none of those" is his own words.
    expect(pick("None of those.")).toEqual({ _tag: "Words", text: "None of those." })
    // What he wants done with the question itself.
    expect(["Say that again.", "What are the options?", "Later.", "Skip.", "Never mind."].map((heard) => pick(heard)?._tag)).toEqual(["Again", "More", "Later", "Leave", "Leave"])
    expect(Questions.pick(networks, "Skip.", { inFull: true, parts: 2 })).toEqual({ _tag: "Skip" })
    // Only an option's name in full picks one it's a word of; anything more is the model's.
    const next = part("What next?", ["Skip the flaky test", "Stop", "Keep going"])
    expect(["Skip.", "Stop.", "Skip the flaky test."].map((heard) => Questions.pick(next, heard, { inFull: true, parts: 1 }))).toEqual([{ _tag: "Leave" }, picked(1), picked(0)])
    // Said before he'd heard the options, a name like "Stop" or "Later" is only to stop yapd, put it off or hear it again.
    const carry = (labels: ReadonlyArray<string>, heard: string) => Questions.pick(part("Should I carry on with the migration?", labels), heard, { inFull: false, parts: 1 })
    expect([
      carry(["Continue (Recommended)", "Stop"], "Stop."),
      carry(["Now (Recommended)", "Later"], "Later."),
      carry(["Go on (Recommended)", "Repeat"], "Repeat."),
      carry(["Go on (Recommended)", "Pause it"], "Pause it."),
      // Never handed to the model either, when an option starts like them.
      carry(["Retry (Recommended)", "Cancel the migration"], "Cancel."),
    ]).toEqual([{ _tag: "Leave" }, { _tag: "Later" }, { _tag: "Again" }, picked(1), { _tag: "Leave" }])
    // Words that let it go but start an option may be that option, which the model tells; words to stop talking, or "never mind", let it go.
    const changelog = part("Should I also update the changelog?", ["Update the changelog", "Leave the changelog"])
    const deploy = part("The deploy is failing. What now?", ["Cancel the deploy", "Retry the deploy (Recommended)"])
    const tests = part("The slow tests take ten minutes. What should I do?", ["Skip the slow tests", "Run everything"])
    expect([Questions.pick(changelog, "Leave it.", { inFull: true, parts: 1 }), Questions.pick(deploy, "Cancel.", { inFull: true, parts: 1 })]).toEqual([undefined, undefined])
    expect(Questions.pick(tests, "Skip that one.", { inFull: true, parts: 2 })).toBeUndefined()
    // "Later" with more to it, to an option named or starting so, is the same: the model's once he's heard it.
    const when = (labels: ReadonlyArray<string>, heard: string, inFull: boolean) => Questions.pick(part("When should I deploy?", labels), heard, { inFull, parts: 1 })?._tag
    expect([when(["Now", "Later today"], "Later.", true), when(["Now", "Tonight"], "Later, please.", true)]).toEqual([undefined, "Later"])
    // With more parts after it, "skip it" to "Skip the slow tests" may be that option too, so it's asked which of them; "next" still skips it.
    const going = ["Skip it.", "Skip.", "Next.", "Never mind.", "Forget it."].map((heard) => Questions.pick(tests, heard, { inFull: true, parts: 2 })?._tag)
    expect(going).toEqual(["Which", "Which", "Skip", "Leave", "Leave"])
    // A form that takes only its options asks which of them, rather than send words it can't take.
    expect(Questions.pick(part("Which colour?", ["Red", "Blue"], { allowCustomAnswer: false }), "Neither.", { inFull: true, parts: 1 })).toEqual({ _tag: "Which" })
  })

  test("every mark in a name counts as it's written, so a symbol, a comma or a hyphen of his own, or one he leaves out, is the model's to tell", () => {
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    const pick = (labels: ReadonlyArray<string>, heard: string) => Questions.pick(part("What should I do?", labels), heard, { inFull: true, parts: 1 })
    expect(["C++.", "C.", "c++", "Rust."].map((heard) => pick(["C", "C++", "Rust"], heard))).toEqual([picked(1), picked(0), picked(1), picked(2)])
    expect(["No tests.", "No, tests.", "No - tests.", "No-tests."].map((heard) => pick(["Tests", "No tests (Recommended)"], heard))).toEqual([picked(1), undefined, undefined, undefined])
    // A name that ends in a mark is its name with that mark.
    expect(["Ship it!", "Ship it.", "Ship it"].map((heard) => pick(["Ship it!", "Hold it"], heard))).toEqual([picked(0), undefined, undefined])
  })

  test("said over yapd's pick before he heard it, only an option's exact name among his words names it, never with a no", () => {
    const waiting = part("What should I do with the branch?", ["Merge now (Recommended)", "Wait for CI"])
    expect(["Merge now, I think.", "merge now", "Merge nowhere.", "Don't merge, I think.", "The first one.", "Not the first one."].map((heard) => Questions.mentions(waiting, 0, heard))).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ])
    expect(["Wait for CI, I think.", "Wait, I think.", "CI, I think.", "Don't wait for CI."].map((heard) => Questions.mentions(waiting, 1, heard))).toEqual([true, false, false, false])
    const languages = part("Which language should the bindings use?", ["C", "C++ (Recommended)", "Rust"])
    expect([Questions.mentions(languages, 0, "C++, I think."), Questions.mentions(languages, 1, "C++, I think.")]).toEqual([false, true])
  })

  test("of several, only exact names joined by ', ' or ' and ', each a different option's, are taken without the model: 'all', 'just Beta' or names alike are the model's", () => {
    const extras = part("Which test extras should run?", ["Alpha", "Beta", "Gamma (Recommended)", "Full history"], { multiSelect: true })
    const pick = (heard: string) => Questions.pick(extras, heard, { inFull: true, parts: 2 })
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    expect(pick("Alpha and Gamma.")).toEqual(picked(0, 2))
    expect(pick("gamma and alpha")).toEqual(picked(0, 2))
    expect(pick("Alpha, Beta and full history.")).toEqual(picked(0, 1, 3))
    for (const heard of ["Alpha, Beta, and Gamma.", "Alpha and Alpha.", "Just Beta.", "All."]) {
      expect([heard, pick(heard)]).toEqual([heard, undefined])
    }
    // Names a list may be read as two ways are the model's to tell.
    const checks = part("Which checks should run?", ["Lint and tests", "Lint", "Tests"], { multiSelect: true })
    expect(["Lint and tests.", "Lint.", "Lint, tests."].map((heard) => Questions.pick(checks, heard, { inFull: true, parts: 1 }))).toEqual([undefined, picked(1), picked(1, 2)])
    // Only one is taken where only one can be.
    expect(Questions.pick(part("Which colour?", ["Red", "Blue"]), "Red and Blue.", { inFull: true, parts: 1 })).toBeUndefined()
    // Sent as a list straight to the agent, and as one string when T3 Code takes the answer as a message.
    const asked = question(extras.id, ["Alpha", "Beta", "Gamma (Recommended)", "Full history"], { multiSelect: true })
    expect(Questions.answers({ questions: [asked], mode: "live" }, { [asked.id]: { _tag: "Picked", options: [0, 2] } })).toEqual(Either.right({ [asked.id]: ["Alpha", "Gamma (Recommended)"] }))
    expect(Questions.answers({ questions: [asked], mode: "message" }, { [asked.id]: { _tag: "Picked", options: [0, 2] } })).toEqual(Either.right({ [asked.id]: "Alpha, Gamma (Recommended)" }))
  })

  test("the model's answer comes back to the options only when each line is exactly one's name, by the same rule as his words, or else to his own words", () => {
    const colour = part("Which colour should the test use?", ["Red", "Blue (Recommended)"])
    const extras = part("Which test extras should run?", ["Alpha", "Beta", "Gamma"], { multiSelect: true })
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    expect(Questions.resolve(colour, "Blue (Recommended)")).toEqual(picked(1))
    expect(Questions.resolve(colour, "blue.")).toEqual(picked(1))
    expect(Questions.resolve(extras, "Alpha\nGamma")).toEqual(picked(0, 2))
    expect(Questions.resolve(extras, "Alpha, Gamma")).toEqual({ _tag: "Words", text: "Alpha, Gamma" })
    // Never with words of its own, nor several where only one can be.
    expect(Questions.resolve(colour, "Blue, but only for the tests.")).toEqual({ _tag: "Words", text: "Blue, but only for the tests." })
    expect(Questions.resolve(colour, "Red\nBlue")).toEqual({ _tag: "Words", text: "Red\nBlue" })
    // An option with more on a line of its own is his words, all of them, never only the option.
    expect(Questions.resolve(colour, "Blue\nbut only for the tests")).toEqual({ _tag: "Words", text: "Blue\nbut only for the tests" })
    expect(Questions.resolve(colour, " ")).toEqual({ _tag: "Again" })
    expect(Questions.resolve(part("Which colour?", ["Red", "Blue"], { allowCustomAnswer: false }), "Green.")).toEqual({ _tag: "Which" })
  })

  test("what's sent leaves out a part he skipped, needs every part a message needs, and never goes under an id or an option the question doesn't have", () => {
    const colour = question("Which colour?", ["Red", "Blue"])
    const notes = question("Anything else?", [], { required: false })
    const both = { questions: [colour, notes], mode: "live" as const }
    expect(Questions.answers(both, { [colour.id]: { _tag: "Picked", options: [0] }, [notes.id]: { _tag: "Skip" } })).toEqual(Either.right({ [colour.id]: "Red" }))
    expect(Questions.answers(both, { [colour.id]: { _tag: "Skip" }, [notes.id]: { _tag: "Skip" } })).toEqual(Either.right({}))
    expect(Questions.answers({ ...both, mode: "message" }, { [colour.id]: { _tag: "Skip" }, [notes.id]: { _tag: "Words", text: "No." } })).toEqual(Either.left("unanswered"))
    expect(Questions.answers({ ...both, mode: "message" }, { [colour.id]: { _tag: "Words", text: "Green." } })).toEqual(Either.right({ [colour.id]: "Green." }))
    expect(Questions.answers(both, { "Which color?": { _tag: "Picked", options: [0] } })).toEqual(Either.left("mismatched"))
    expect(Questions.answers(both, { [colour.id]: { _tag: "Picked", options: [2] } })).toEqual(Either.left("mismatched"))
  })
})
