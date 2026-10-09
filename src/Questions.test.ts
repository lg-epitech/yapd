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

/** What's only told of a question, when it isn't asked. */
const told = (...parts: ReadonlyArray<Questions.Said>) => {
  const worded = Questions.worded({ called: "the Tezos migration", parts, lines })
  return worded._tag === "Tell" ? worded.spoken : Option.some(`Asked: ${worded.parts[0]?.first}`)
}

/**
 * Every answer review found sent another option than the one he meant
 * without the model, by the question, its options and what he said: the
 * same words in other roles, what an option leaves out or puts in another's
 * place, "just" or "only", a plain yes or no to options that start with no,
 * a verb of his own or none, and a no to one with "not" in another's name.
 * Several when he could pick several.
 */
const misread: ReadonlyArray<readonly [asked: string, labels: ReadonlyArray<string>, heard: ReadonlyArray<string>, several?: boolean]> = [
  ["What should I fix?", ["Fix the test, not the code (Recommended)", "Fix the code"], ["The code, not the test."]],
  ["What should I do with the data?", ["Copy the prod database to staging", "Leave staging as is"], ["Copy staging to prod."]],
  ["What should I keep?", ["Keep the tests, drop the docs (Recommended)", "Keep both"], ["Keep the docs, drop the tests."]],
  ["How should I land it?", ["Squash, don't rebase", "Rebase"], ["Rebase, don't squash."]],
  ["Which database?", ["Use Postgres instead of SQLite (Recommended)", "Keep SQLite"], ["SQLite instead of Postgres."]],
  ["How should I update the branch?", ["Merge main into the feature branch (Recommended)", "Rebase instead"], ["Merge the feature branch into main."]],
  ["When should I merge?", ["Merge now (Recommended)", "Not now, maybe later"], ["Now, not later."]],
  ["What should I rename?", ["Rename foo to bar", "Keep the name"], ["Rename bar to foo."]],
  ["What next?", ["Merge, then deploy", "Wait"], ["Deploy, then merge."]],
  ["Which checks should run?", ["Lint the code, not the docs", "Tests", "Docs"], ["Docs, not the code."], true],
  ["Which backups should I delete?", ["Delete all but the latest backup (Recommended)", "Delete all backups"], ["Delete the latest backup."]],
  ["What should I delete?", ["Delete everything but the logs", "Delete nothing"], ["Delete the logs."]],
  ["What should I deploy?", ["Deploy all services other than billing", "Hold off"], ["Deploy billing."]],
  ["What should I update?", ["Update every package apart from React", "Leave them"], ["Update React."]],
  ["What should I restart?", ["Restart all workers besides the scheduler", "Leave them running"], ["Restart the scheduler."]],
  ["What should I migrate?", ["Migrate all tables but users (Recommended)", "Wait"], ["Migrate users."]],
  ["Which cache?", ["Use Redis in place of Memcached (Recommended)", "Leave the cache alone"], ["Use Memcached.", "Memcached."]],
  ["Which date library?", ["Replace Moment with Day.js (Recommended)", "Leave it as is"], ["Use Moment."]],
  ["Which package manager?", ["Switch from npm to Bun", "Leave it"], ["npm."]],
  ["What matters more?", ["Speed over accuracy (Recommended)", "Balance both"], ["Accuracy over speed."]],
  ["What should I run before pushing?", ["Tests and lint (Recommended)", "Nothing"], ["Just lint.", "Only lint.", "Lint only.", "Only the tests."]],
  ["Where should I deploy?", ["Deploy to staging and production (Recommended)", "Hold off"], ["Just staging.", "Staging only."]],
  ["Which tests?", ["Run unit and integration tests", "Skip tests"], ["Only the unit tests."]],
  ["What should I update?", ["Update the lockfile and package.json", "Leave them"], ["Just the lockfile."]],
  ["Which checks should run?", ["Lint and tests", "Docs"], ["Only tests."], true],
  ["Should I drop the cache layer?", ["Keep it (Recommended)", "No cache"], ["No.", "Yes."]],
  ["Should I skip the tests to save time?", ["Run the full suite (Recommended)", "No tests"], ["No."]],
  ["Do you want me to keep the old endpoints?", ["Remove them", "No change"], ["No."]],
  ["Should I skip CI?", ["No CI", "Run CI"], ["No."]],
  ["Should I delete the old branch?", ["Keep it (Recommended)", "Delete it", "No preference"], ["No.", "Yes."]],
  ["What about the cache?", ["Bypass the cache (Recommended)", "Rebuild it"], ["Use the cache.", "Go with the cache."]],
  ["What about the feature branch?", ["Abandon the feature branch", "Rebase it"], ["Take the feature branch."]],
  ["What about the deploy?", ["Roll back the deploy (Recommended)", "Keep it running"], ["Deploy."]],
  ["What about the migration?", ["Dry run the migration (Recommended)", "Skip it"], ["Run the migration."]],
  ["How should I push?", ["Force push", "Open a new branch"], ["Push."]],
  ["What about the migration?", ["Abandon the migration", "Keep going"], ["The migration."]],
  ["What about the PR?", ["Close the PR (Recommended)", "Merge it"], ["The PR."]],
  ["What about the old SDK?", ["Uninstall the old SDK", "Leave it"], ["The old SDK."]],
  ["What about the old flag?", ["Disallow the old flag", "Keep it"], ["The old flag."]],
  ["How many retries?", ["Up to 3 retries", "No retries"], ["Three retries."]],
  ["What should I do with the branch?", ["Merge now (Recommended)", "Do not merge yet", "Close the PR"], ["Not that one.", "Not this one.", "Not."]],
]

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
    // Asked with yapd's pick, and what's sent stays the label as the agent wrote it.
    const library = part("Which library should we use for date formatting?", ["date-fns (Recommended)", "`Day.js`", "Luxon"])
    expect(wording(library)[0]!.first).toBe("A question on the Tezos migration, sir: Which library should we use for date formatting? date-fns, Day.js or Luxon? I'd go with date-fns.")
    expect(Questions.answers({ questions: [question(library.id, ["date-fns (Recommended)", "`Day.js`", "Luxon"])], mode: "live" }, { [library.id]: { _tag: "Picked", options: [0] } })).toEqual(
      Either.right({ [library.id]: "date-fns (Recommended)" }),
    )
    // Two options marked: no pick.
    expect(wording(part("Which colour?", ["Red (Recommended)", "Blue (Recommended)"]))[0]!.first).toBe("A question on the Tezos migration, sir: Which colour? Red or Blue?")
    // A label in code is still asked, by what it means.
    expect(wording(part("Which date helper?", ["date-fns", { label: "src/utils/date.ts", description: "Keep the helper we wrote." }]))[0]!.first).toBe(
      "A question on the Tezos migration, sir: Which date helper? date-fns or option two, keep the helper we wrote?",
    )
    // Names that say nothing are read with what they mean.
    const opaque = part("How should the cache be handled?", [
      { label: "Option A", description: "Keep the cache. It's warm already." },
      { label: "Option B", description: "Drop it and rebuild." },
    ])
    expect(opaque.opaque).toBe(true)
    expect(wording(opaque)[0]!.first).toBe("A question on the Tezos migration, sir: How should the cache be handled? Option A, keep the cache; option B, drop it and rebuild?")
    // Mostly known only by their number, it's only told, as is one with nothing to ask.
    expect(told(part("Which file?", ["~/a/b.json", "~/c/d.json", "Neither"]))).toEqual(Option.none())
    expect(told(Questions.said(question("x", []), Option.none()))).toEqual(Option.none())
  })

  test("the line leaves out options the question names already, and Yes or No", () => {
    expect(wording(part("Should we use Red or Blue for the test?", ["Red", "Blue (Recommended)"]))[0]!.first).toBe(
      "A question on the Tezos migration, sir: Should we use Red or Blue for the test? I'd go with Blue.",
    )
    expect(wording(part("Should I also migrate the invoices table?", ["Yes (Recommended)", "No"]))[0]!.first).toBe(
      "A question on the Tezos migration, sir: Should I also migrate the invoices table? I'd say yes.",
    )
    expect(wording(part("Should I also bump the version?", []))[0]!.first).toBe("A question on the Tezos migration, sir: Should I also bump the version?")
    // An option the question doesn't name is read.
    expect(wording(part("Should we use Red or Blue?", ["Red", "Blue", "Green"]))[0]!.first).toBe("A question on the Tezos migration, sir: Should we use Red or Blue? Red, Blue or Green?")
    // Several can be picked.
    expect(wording(part("Which test extras should run?", ["Alpha", "Beta", "Gamma"], { multiSelect: true }))[0]!.first).toBe(
      "A question on the Tezos migration, sir: Which test extras should run? Any of Alpha, Beta and Gamma?",
    )
    expect(wording(part("Which checks should run?", ["Lint", "Types"], { multiSelect: true }))[0]!.first).toBe("A question on the Tezos migration, sir: Which checks should run? Lint, Types or both?")
  })

  test("a question in parts is asked one at a time, each after what the last was answered with, and brought back from where he'd got to", () => {
    const colour = part("Which colour should the test use?", ["Red", "Blue (Recommended)"])
    const extras = part("Which test extras should run?", ["Alpha", "Beta", "Gamma"], { multiSelect: true })
    const [first, second] = wording(colour, extras)
    expect(first!.first).toBe("Two questions on the Tezos migration, sir. First: Which colour should the test use? Red or Blue? I'd go with Blue.")
    expect(second!.last(Questions.ack(colour, { _tag: "Picked", options: [0] }))).toBe("Red, sir. And last: Which test extras should run? Any of Alpha, Beta and Gamma?")
    expect(second!.last(Questions.ack(colour, { _tag: "Words", text: "Red, but only for now." }))).toStartWith("Noted, sir. And last:")
    expect(Questions.ack(extras, { _tag: "Picked", options: [0, 2] })).toBe("Alpha and Gamma")
    expect(first!.here).toStartWith("Here are the two questions on the Tezos migration, sir. First: Which colour")
    expect(second!.here).toBe("Here's the last question on the Tezos migration, sir: Which test extras should run? Any of Alpha, Beta and Gamma?")
    // Again in full, in other words each time; still unanswered; what they mean; which one then; let go.
    expect(first!.again).toEqual([
      "Again, sir: Which colour should the test use? Red or Blue? I'd go with Blue.",
      "Once more, sir: Which colour should the test use? Red or Blue? I'd go with Blue.",
      "Here it is again, sir: Which colour should the test use? Red or Blue? I'd go with Blue.",
    ])
    expect(first!.still).toEqual([
      "Back to the Tezos migration, sir: Which colour should the test use? Red or Blue? I'd go with Blue.",
      "The Tezos migration still needs an answer, sir: Which colour should the test use? Red or Blue? I'd go with Blue.",
    ])
    const described = part("Which colour should the test use?", [
      { label: "Red", description: "A red test." },
      { label: "Blue (Recommended)", description: "A blue test. It matches the theme." },
      { label: "Green", description: "" },
    ])
    expect(wording(described)[0]!.more).toBe("Red: a red test. Blue: a blue test. Green. I'd go with Blue. Which one, sir?")
    expect(wording(described)[0]!.instead).toBe("Which one then, sir: Red or Green?")
    expect(first!.instead).toBe("Red then, sir?")
    // Words a form can't take: which of them all, yapd's pick kept.
    expect(first!.which).toBe("Which one, sir: Red or Blue? I'd go with Blue.")
    expect(second!.which).toBe("Which of them, sir: Alpha, Beta or Gamma?")
    expect(first!.letGo).toBe("I'll leave the question on the Tezos migration for now, sir; ask me for it when you're ready.")
    expect(wording(part("Which library?", ["`date-fns`", "Day.js"]))[0]!.terms).toEqual(["date-fns", "Day.js"])
  })

  test("a question with too many options or parts to take in is only told, with what it asks", () => {
    expect(told(part("Which network first?", ["Mainnet", "Ghostnet", "Shadownet", "Weeklynet", "Localnet"]))).toEqual(
      Option.some("A question on the Tezos migration, sir: Which network first? It has five options, so it's waiting for you in T3 Code."),
    )
    const many = ["One?", "Two?", "Three?", "Four?", "Five?"].map((asked) => part(asked, []))
    expect(told(...many)).toEqual(Option.some("Five questions on the Tezos migration, sir: that's too many to ask you one at a time, so they're waiting for you in T3 Code."))
    // Four parts are still asked.
    expect(wording(...many.slice(0, 4))[0]!.first).toBe("Four questions on the Tezos migration, sir. First: One?")
    // With its words unsayable and the model failing, its header stands in.
    expect(wording(Questions.said(question("Use `oauth2` or `apikey`?", ["OAuth", "API key"], { header: "Auth method" }), Option.none()))[0]!.first).toBe(
      "A question on the Tezos migration, sir: About auth method: OAuth or API key?",
    )
  })

  test("answers are taken without the model only by an option's whole name, as written, as compared or by how it sounds, its place, a plain yes to the pick once heard in full, and a plain yes or no to the option named so", () => {
    const networks = part("Which network should we start with?", ["Mainnet", "Ghostnet (Recommended)", "Full history", "Shadow testnet"])
    const pick = (heard: string, inFull = true) => Questions.pick(networks, heard, { inFull, parts: 1 })
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    for (const [heard, index] of [
      ["Mainnet.", 0],
      ["Ghostnet (Recommended)", 1],
      ["ghost net", 1],
      ["Uh, Main net, please.", 0],
      ["The third one.", 2],
      ["Second.", 1],
      ["Number two.", 1],
      ["Option 4.", 3],
      ["Option D.", 3],
      ["Last.", 3],
      // A bare number or letter may be what he means itself, which the model tells.
      ["Four.", undefined],
      ["C.", undefined],
      ["Full history.", 2],
      // A "the" before it, or a "please" or "sir" after it, says nothing of which.
      ["The full history.", 2],
      ["Shadow testnet, sir.", 3],
      // Part of a name, or more than it, is the model's to tell.
      ["The full history one.", undefined],
      ["Shadow.", undefined],
      ["Full.", undefined],
      ["Yes.", 1],
      // Agreeing past a plain yes is the model's to tell.
      ["Sounds good.", undefined],
      ["Go with what you recommend.", 1],
      ["Your pick.", 1],
      ["You decide.", 1],
    ] as const) {
      expect([heard, pick(heard)]).toEqual([heard, index === undefined ? undefined : picked(index)])
    }
    // Cut off before yapd said its pick, a yes is asked again in full, and a no may be to the question, which is the model's.
    expect(pick("Yes.", false)).toEqual({ _tag: "Again" })
    expect(pick("No.", false)).toBeUndefined()
    // A plain no to the pick: which one then.
    expect(pick("No.")).toEqual({ _tag: "Instead" })
    // A letter is a letter's own option when one is called by one, and no option's place when one is.
    expect(Questions.pick(part("Which plan?", ["A", "B", "Neither"]), "B.", { inFull: true, parts: 1 })).toEqual(picked(1))
    expect(Questions.pick(part("Which grade?", ["B", "A"]), "A.", { inFull: true, parts: 1 })).toEqual(picked(1))
    expect(Questions.pick(part("Which plan?", ["A", "Keep going", "Stop"]), "C.", { inFull: true, parts: 1 })).toBeUndefined()
    // Yes or no to the option that is one, named so or with a comma after it, whatever yapd would pick.
    const migrate = part("Should I migrate the invoices too?", ["Yes, all of them", "No (Recommended)"])
    expect(Questions.pick(migrate, "Yeah.", { inFull: true, parts: 1 })).toEqual(picked(0))
    expect(Questions.pick(migrate, "Nope.", { inFull: true, parts: 1 })).toEqual(picked(1))
    // With nothing to pick from, a yes or a no is his answer, and so are "you decide" and "none of those".
    const bump = part("Should I also bump the version?", [])
    expect(Questions.pick(bump, "No.", { inFull: true, parts: 1 })).toEqual({ _tag: "Words", text: "No" })
    expect(Questions.pick(part("Which colour?", ["Red", "Blue"]), "Up to you.", { inFull: true, parts: 1 })).toEqual({ _tag: "Words", text: "You decide." })
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
      carry(["Go on (Recommended)", "Never mind"], "Never mind."),
      carry(["Go on (Recommended)", "Repeat"], "Repeat."),
      carry(["Go on (Recommended)", "Pause it"], "Pause it."),
      // Never handed to the model either, when an option is named or starts like them.
      carry(["Proceed (Recommended)", "Cancel"], "Cancel."),
      carry(["Go on (Recommended)", "Drop it"], "Drop it."),
      carry(["Go on (Recommended)", "Leave it"], "Leave it."),
      carry(["Retry (Recommended)", "Cancel the migration"], "Cancel."),
    ]).toEqual([{ _tag: "Leave" }, { _tag: "Later" }, { _tag: "Leave" }, { _tag: "Again" }, picked(1), { _tag: "Leave" }, { _tag: "Leave" }, { _tag: "Leave" }, { _tag: "Leave" }])
    // With more parts after it, "skip it" to "Skip the slow tests" still asks which of them, never sounding as if it was taken.
    expect(Questions.pick(part("What should I do?", ["Skip the slow tests", "Run everything"]), "Skip it.", { inFull: false, parts: 2 })).toEqual({ _tag: "Which" })
    // Words that let it go but start an option may be that option, which the model tells; words to stop talking, or "never mind", let it go.
    const changelog = part("Should I also update the changelog?", ["Update the changelog", "Leave the changelog"])
    const deploy = part("The deploy is failing. What now?", ["Cancel the deploy", "Retry the deploy (Recommended)"])
    const tests = part("The slow tests take ten minutes. What should I do?", ["Skip the slow tests", "Run everything"])
    expect([Questions.pick(changelog, "Leave it.", { inFull: true, parts: 1 }), Questions.pick(deploy, "Cancel.", { inFull: true, parts: 1 })]).toEqual([undefined, undefined])
    expect(Questions.pick(tests, "Skip that one.", { inFull: true, parts: 2 })).toBeUndefined()
    // With more parts after it, "skip it" to "Skip the slow tests" may be that option too, so it's asked which of them; "next" still skips it.
    const going = ["Skip it.", "Skip.", "Next.", "Never mind.", "Forget it."].map((heard) => Questions.pick(tests, heard, { inFull: true, parts: 2 })?._tag)
    expect(going).toEqual(["Which", "Which", "Skip", "Leave", "Leave"])
    expect(Questions.pick(networks, "Skip it.", { inFull: true, parts: 2 })).toEqual({ _tag: "Skip" })
    expect(["Leave it.", "Cancel."].map((heard) => Questions.pick(networks, heard, { inFull: true, parts: 1 })?._tag)).toEqual(["Leave", "Leave"])
    // "Next" to "Next release" is the same: which of them with more parts after it, never skipped; the model's when it's more than words to
    // stop talking; and, like "skip it", let go with one part, never sending that option.
    const release = part("Which release should this go in?", ["Next release (Recommended)", "This release"])
    expect(["Next.", "Next one.", "Next question."].map((heard) => Questions.pick(release, heard, { inFull: true, parts: 2 })?._tag)).toEqual(["Which", undefined, undefined])
    expect(["Next.", "Next one."].map((heard) => Questions.pick(release, heard, { inFull: true, parts: 1 })?._tag)).toEqual(["Leave", undefined])
    const releases = part("Which release should this go in?", ["Next release (Recommended)", "Next sprint", "This release"])
    expect(Questions.pick(releases, "Next.", { inFull: true, parts: 2 })).toEqual({ _tag: "Which" })
    expect(pick("Ghostnet, but only for the tests.")).toBeUndefined()
    expect(pick("Mainnet and Ghostnet.")).toBeUndefined()
    // A form that takes only its options asks which of them, rather than send words it can't take.
    expect(Questions.pick(part("Which colour?", ["Red", "Blue"], { allowCustomAnswer: false }), "Neither.", { inFull: true, parts: 1 })).toEqual({ _tag: "Which" })
  })

  test("only a 'the' before a name, a 'please' or 'sir' after it and fillers like 'uh' go without saying, never yapd's name or a 'please' within, so a longer name never comes to a shorter one", () => {
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    const pick = (labels: ReadonlyArray<string>, heard: string) => Questions.pick(part("What should I do?", labels), heard, { inFull: true, parts: 1 })
    for (const [labels, heard] of [
      [["Restart", "Restart yapd"], "Restart yapd, please."],
      [["Voice", "Jarvis voice"], "Jarvis voice, please."],
      [["Restart", "Restart yapd"], "Um, restart yapd."],
      [["Restart", "Restart Jarvis"], "Restart Jarvis please."],
      [["Hold", "Please hold"], "Please hold, sir."],
    ] as const) {
      expect([heard, pick(labels, heard)]).toEqual([heard, picked(1)])
      expect([heard, Questions.resolve(part("What should I do?", labels), heard)]).toEqual([heard, picked(1)])
    }
    expect(Questions.resolve(part("What should I do?", ["Restart", "Restart yapd"]), "Restart yapd, sir.")).toEqual(picked(1))
    // Those still go without saying around a name that hasn't them.
    expect(["Hold, please.", "Uh, hold, sir.", "The hold."].map((heard) => pick(["Hold", "Wait"], heard))).toEqual([picked(0), picked(0), picked(0)])
    // A name that ends in "please" is as much his words with it as without: the model tells.
    expect(pick(["Hold", "Hold please"], "Hold, please.")).toBeUndefined()
  })

  test("a no with a stop after it, like 'No, tests.', is his no then a name, never the option it would turn, which the model tells", () => {
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    const pick = (labels: ReadonlyArray<string>, heard: string, several = false) => Questions.pick(part("What should I do?", labels, { multiSelect: several }), heard, { inFull: true, parts: 1 })
    for (const [labels, heard] of [
      [["Tests", "No tests (Recommended)"], "No, tests."],
      [["Merge", "No merge (Recommended)"], "No, merge."],
      [["Merge", "Don't merge"], "Don't. Merge."],
      [["Merge", "Don't merge"], "Don’t, merge."],
      [["Retry", "Never retry"], "Never, retry."],
      [["Tests", "No tests"], "Nope, tests."],
      [["Tests", "No tests"], "No? Tests."],
    ] as const) {
      expect([heard, pick(labels, heard), Questions.resolve(part("What should I do?", labels), heard)]).toEqual([heard, undefined, { _tag: "Words", text: heard }])
    }
    // Said so, "not now" puts it off, never sending the option named so.
    expect(pick(["Now", "Not now"], "Not. Now.")).toEqual({ _tag: "Later" })
    // Nor, of several, is it a list of the option called No and a name.
    expect(pick(["No", "Tests", "Docs"], "No, tests.", true)).toBeUndefined()
    // A name with the same stop is still that option, and one said without a stop is plain.
    expect(pick(["No, skip tests", "Run tests"], "No, skip tests.")).toEqual(picked(0))
    expect(pick(["Tests", "No tests"], "No tests.")).toEqual(picked(1))
    expect(pick(["Merge", "Don't merge"], "Don’t merge.")).toEqual(picked(1))
  })

  test("a no never comes to a name by how it sounds when the name hides it, like 'not able' to Notable or 'no body' to Nobody", () => {
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    const pick = (labels: ReadonlyArray<string>, heard: string) => Questions.pick(part("What should I do?", labels), heard, { inFull: true, parts: 1 })
    expect([pick(["Notable changes only", "Everything"], "Not able changes only."), pick(["Nobody", "Everyone"], "No body.")]).toEqual([undefined, undefined])
    expect(Questions.resolve(part("What should I do?", ["Notable changes only", "Everything"]), "Not able changes only")).toEqual({ _tag: "Words", text: "Not able changes only" })
    // A name with a no of its own still sounds as it's said, and so does one said as written.
    expect([pick(["Cannot reproduce", "Fixed"], "Can not reproduce."), pick(["Nobody", "Everyone"], "Nobody.")]).toEqual([picked(0), picked(0)])
  })

  test("taking back what he said, like 'cancel that', is the model's to tell, never an option it's a word of", () => {
    const pick = (asked: Questions.Said, heard: string) => Questions.pick(asked, heard, { inFull: true, parts: 1 })
    const deploy = part("The deploy failed. What now?", ["Retry (Recommended)", "Cancel the deploy"])
    expect(["Cancel that.", "Scratch that.", "Cancel."].map((heard) => pick(deploy, heard))).toEqual([undefined, undefined, undefined])
    expect(pick(part("The migration failed halfway. What now?", ["Retry (Recommended)", "Undo the migration"]), "Undo that.")).toBeUndefined()
    // Only an option named just so takes it.
    expect(pick(part("What should I do with the last commit?", ["Keep it (Recommended)", "Scratch that"]), "Scratch that.")).toEqual({ _tag: "Picked", options: [1] })
  })

  test("words that are only part of an option's name, and leave out or add what turns it around, like 'not', 'skip' or 'instead of', are the model's to tell, never that option", () => {
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    const pick = (labels: ReadonlyArray<string>, heard: string) => Questions.pick(part("What should I do with the branch?", labels), heard, { inFull: true, parts: 1 })
    for (const [labels, heard] of [
      // He heard both, and wants the opposite of the one his words are part of.
      [["Open a draft pull request (Recommended)", "Do not merge now"], "Merge now."],
      [["Merge now", "Do not merge now"], "Do not merge."],
      [["Run tests", "Skip tests"], "Skip the tests."],
      [["Open a draft pull request (Recommended)", "Do not merge now"], "The draft one."],
      [["Do not merge", "Wait for CI"], "Merge."],
      [["Skip tests", "Merge now"], "Tests."],
      [["Merge now", "Don’t run the tests"], "The tests."],
      [["Squash instead of rebasing", "Rebase now"], "Rebasing."],
      [["Squash rather than rebase", "Merge"], "Rebase."],
      [["Revert the migration", "Fix forward"], "The migration."],
      [["Keep the cache", "Rebuild it"], "The cache."],
      [["Merge now (Recommended)", "Wait for CI"], "For CI."],
      // Or turns around one his words are all of.
      [["Merge now", "Wait for CI"], "Don't merge."],
      [["Merge now", "Do not merge"], "Merge it."],
    ] as const) {
      expect([heard, pick(labels, heard)]).toEqual([heard, undefined])
    }
    // An option named in full is plain, whatever turns it, written any way.
    expect(pick(["Red", "Blue"], "Blue.")).toEqual(picked(1))
    expect(pick(["Keep it", "Don't keep it"], "Keep it.")).toEqual(picked(0))
    expect(pick(["Keep it", "Don't keep it"], "Don’t keep it.")).toEqual(picked(1))
    expect(pick(["Run tests", "Skip tests"], "Skip tests.")).toEqual(picked(1))
    expect(pick(["Add tests", "No tests"], "No tests.")).toEqual(picked(1))
    expect(pick(["Merge now", "Do not merge now"], "Do not merge now.")).toEqual(picked(1))
    expect(pick(["Cannot reproduce", "Fixed"], "Can not reproduce.")).toEqual(picked(0))
    // The model's answer, or his words dictated to the thread, are his own words then, never that option.
    const merge = part("What should I do with the branch?", ["Open a draft pull request (Recommended)", "Do not merge now"])
    expect(Questions.resolve(merge, "Merge now")).toEqual({ _tag: "Words", text: "Merge now" })
    expect(Questions.resolve(merge, "Do not merge now")).toEqual(picked(1))
    // Nor do they name it, as what he said over yapd's pick before he heard it: only its whole name or its place does, never with a no.
    const waiting = part("What should I do with the branch?", ["Merge now (Recommended)", "Wait for CI"])
    expect(["Merge now, I think.", "Don't merge, I think.", "The first one.", "Not the first one."].map((heard) => Questions.mentions(waiting, 0, heard))).toEqual([
      true,
      false,
      true,
      false,
    ])
    expect(["Wait for CI, I think.", "Wait, I think.", "CI, I think.", "Don't wait for CI."].map((heard) => Questions.mentions(waiting, 1, heard))).toEqual([true, false, false, false])
    // Of several, each piece is held to the same: only whole names.
    const checks = part("Which checks should run?", ["Lint", "Tests", "Skip docs"], { multiSelect: true })
    const several = (heard: string) => Questions.pick(checks, heard, { inFull: true, parts: 1 })
    expect(["Lint and docs.", "All but docs.", "Lint and skip docs.", "All but skip docs."].map(several)).toEqual([undefined, undefined, picked(0, 2), undefined])
    expect(Questions.resolve(checks, "Lint\nDocs")).toEqual({ _tag: "Words", text: "Lint\nDocs" })
    expect(Questions.pick(part("Which checks should run?", ["No", "Docs", "Tests"], { multiSelect: true }), "No docs.", { inFull: true, parts: 1 })).toBeUndefined()
  })

  test("every answer review found sent another option than his without the model, by word order, what an option leaves out, 'just' or a verb, is the model's to tell", () => {
    for (const [asked, labels, said, several = false] of misread) {
      const asking = part(asked, labels, { multiSelect: several })
      for (const heard of said) {
        const answers = [Questions.pick(asking, heard, { inFull: true, parts: 1 }), Questions.pick(asking, heard, { inFull: false, parts: 1 }), Questions.resolve(asking, heard)]
        expect([labels, heard, answers]).toEqual([labels, heard, [undefined, undefined, { _tag: "Words", text: heard }]])
      }
    }
  })

  test("the plain answers stay without the model: an option's whole name, its place, a plain yes to the pick heard in full, and a plain no to an option called No", () => {
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    const pick = (asked: Questions.Said, heard: string) => Questions.pick(asked, heard, { inFull: true, parts: 1 })
    expect(pick(part("Which colour?", ["Red", "Blue"]), "Blue.")).toEqual(picked(1))
    expect(pick(part("Which database?", ["Use Postgres", "Keep SQLite"]), "Use Postgres.")).toEqual(picked(0))
    expect(pick(part("Which colour?", ["Red", "Blue", "Green"]), "The second one.")).toEqual(picked(1))
    expect(pick(part("Which colour?", ["Red", "Blue (Recommended)"]), "Yes.")).toEqual(picked(1))
    expect(pick(part("Should I also migrate the invoices table?", ["Yes", "No"]), "No.")).toEqual(picked(1))
  })

  test("a yes or an okay that starts another option's name, or has its words, is the model's to tell, never yapd's pick", () => {
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    const pick = (options: ReadonlyArray<string>, heard: string, inFull = true) => Questions.pick(part("What now?", options), heard, { inFull, parts: 1 })
    for (const [options, heard] of [
      [["Ship it now", "Hold it for QA (Recommended)"], "Ship it."],
      [["Proceed with the migration", "Wait for review (Recommended)"], "Proceed."],
      [["Go ahead with the rename", "Keep the old name (Recommended)"], "Go ahead."],
      [["Do it again", "Mark it skipped (Recommended)"], "Do it."],
      [["Agreed, ship it", "Revise first (Recommended)"], "Agreed."],
      [["Okay, ship it", "Wait (Recommended)"], "OK."],
      [["Fine as it is", "Rewrite it (Recommended)"], "Fine."],
      [["Ship it now", "Ship it tomorrow (Recommended)"], "Ship it."],
      [["OK, but only on staging", "Not yet (Recommended)"], "Okay, do it."],
      // A yes with words after it that start another option, or are all its own, is to that option as much as to yapd's pick.
      [["Ship it now", "Hold it for QA (Recommended)"], "Yes, ship it."],
      [["Go for it", "Hold off (Recommended)"], "Yes, go for it."],
      [["Not yet (Recommended)", "Merge it now"], "Yes, merge it."],
      [["Proceed with the migration", "Wait for review (Recommended)"], "Yes, proceed."],
      [["Go ahead with the rename", "Keep the old name (Recommended)"], "Sure, go ahead."],
      [["Go ahead with the rename", "Keep the old name (Recommended)"], "Yeah, go ahead."],
      [["Go ahead with the rename", "Keep the old name (Recommended)"], "Sounds good, go ahead."],
      [["Go ahead with the rename", "Keep the old name (Recommended)"], "Okay, go ahead."],
      [["Do it again", "Mark it skipped (Recommended)"], "Yes, do it."],
      [["Do it again", "Mark it skipped (Recommended)"], "OK, do it."],
      [["Do it again", "Mark it skipped (Recommended)"], "Yeah, do it."],
      // A word of his that another option has, wherever it is in its name, may be to that option, however he agrees.
      [["Wait for CI (Recommended)", "Merge now"], "Yes, merge it."],
      [["Wait for CI (Recommended)", "Squash and merge"], "Merge it."],
      [["Wait for CI (Recommended)", "Squash and merge"], "Yes, merge it."],
      [["Hold for QA (Recommended)", "Tag and ship"], "Ship it."],
      [["Hold for QA (Recommended)", "Tag and ship"], "Yes, ship it."],
      // Words to go ahead, to a pick that holds back, may be to going ahead after all.
      [["Pause (Recommended)", "Continue the migration"], "Proceed."],
      [["Pause (Recommended)", "Continue the migration"], "Go on."],
      [["Wait for CI (Recommended)", "Merge now"], "Yes, ship it."],
      [["Wait for CI (Recommended)", "Merge now"], "Yes, do it."],
      [["Not yet (Recommended)", "Deploy"], "Go ahead."],
      [["Keep it for now (Recommended)", "Drop the table"], "Go for it."],
      [["Abort the migration (Recommended)", "Continue anyway"], "Proceed."],
    ] as const) {
      expect([heard, pick(options, heard)]).toEqual([heard, undefined])
      // Cut off before yapd's pick, it may be that option all the same.
      expect([heard, pick(options, heard, false)]).toEqual([heard, undefined])
    }
    // "Okay" is "OK" as Whisper writes it either way, so it's the option by that name.
    expect(pick(["OK", "Wait (Recommended)"], "Okay.")).toEqual(picked(0))
    expect(pick(["Okay", "Wait (Recommended)"], "OK.")).toEqual(picked(0))
    // Going ahead or agreeing past a plain yes is the model's to tell, even where only the pick could be meant; what points at the pick takes it.
    expect(pick(["Ship it now (Recommended)", "Hold it for QA"], "Ship it.")).toEqual(undefined)
    expect(pick(["Ship it now", "Hold it for QA (Recommended)"], "Sounds good.")).toEqual(undefined)
    expect(pick(["Ship it now", "Hold it for QA (Recommended)"], "The recommended one.")).toEqual(picked(1))
    expect(pick(["Go with the old name", "Rename it (Recommended)"], "Yes, go ahead.")).toEqual(undefined)
    expect(pick(["Merge now (Recommended)", "Wait for CI"], "Yes, merge it.")).toEqual(undefined)
    // A plain yes to a pick that holds back takes it, as does pointing at it; going ahead, to any pick, is the model's.
    expect(["Yes.", "Sounds good.", "Your pick."].map((heard) => pick(["Pause (Recommended)", "Continue the migration"], heard))).toEqual([picked(0), undefined, picked(0)])
    expect(["Go on.", "Proceed."].map((heard) => pick(["Keep going (Recommended)", "Stop the run"], heard))).toEqual([undefined, undefined])
  })

  test("a plain yes when yapd's pick is a no, or a yes or no to a question it answers when no option is either, is the model's to tell", () => {
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    const pick = (asked: Questions.Said, heard: string) => Questions.pick(asked, heard, { inFull: true, parts: 1 })
    // "Yes" to "Should I add tests?" is never "No, skip tests", which "no" still is.
    const tests = part("Should I add tests?", ["No, skip tests (Recommended)", "Add unit tests"])
    expect(["Yes.", "Yeah.", "Go ahead.", "No."].map((heard) => pick(tests, heard))).toEqual([undefined, undefined, undefined, picked(0)])
    // Nor when the question isn't one a yes answers.
    expect(pick(part("How should I handle the tests?", ["No tests (Recommended)", "Unit tests", "Full suite"]), "Yes.")).toBeUndefined()
    // "Yes" to "Should I keep the cache?" may be "Keep it", and "no" "Drop it", whatever yapd would pick.
    const cache = part("Should I keep the cache?", ["Drop it (Recommended)", "Keep it"])
    expect(["Yes.", "Sure.", "No.", "Nope."].map((heard) => pick(cache, heard))).toEqual([undefined, undefined, undefined, undefined])
    expect(pick(part("The cache is stale. Can we keep it for now?", ["Drop it (Recommended)", "Keep it"]), "Yes.")).toBeUndefined()
    // However the question that asks whether is put: with any subject, or none, or starting with what it would do.
    for (const asked of [
      "Should migrations run first?",
      "Should tests be added for the loader?",
      "Is caching still needed?",
      "Can CI run without the fixtures?",
      "OK to drop the cache?",
      "Ready to merge?",
      "Proceed with the migration?",
      "Keep the old config?",
      "So, should I do it now?",
      // Or followed by a remark.
      "Should I run the migration now? It locks the table for an hour.",
    ]) {
      expect([asked, pick(part(asked, ["Do it", "Skip it for now (Recommended)"]), "Yes.")]).toEqual([asked, undefined])
    }
    expect(["Yes.", "No."].map((heard) => pick(part("Should I run the migration now? It locks the table for an hour.", ["Skip it for now (Recommended)", "Do it now"]), heard))).toEqual([
      undefined,
      undefined,
    ])
    expect(pick(part("Want me to add tests?", ["Add unit tests", "Skip tests (Recommended)"]), "Yes.")).toBeUndefined()
    // So is an okay, which is as much a yes to the question as to yapd's pick.
    for (const [asked, labels, heard] of [
      ["OK to merge now?", ["Not yet (Recommended)", "Merge now"], "OK."],
      ["OK to merge now?", ["Not yet (Recommended)", "Merge now"], "Okay."],
      ["Is it fine to drop the old table?", ["Keep it for now (Recommended)", "Drop it"], "Fine."],
      ["Is it fine to drop the old table?", ["Keep it for now (Recommended)", "Drop it"], "That's fine."],
      ["Should I keep the cache?", ["Drop it (Recommended)", "Keep it"], "Agreed."],
      ["Should I keep the cache?", ["Drop it (Recommended)", "Keep it"], "Sounds good."],
      ["Should I deploy?", ["No, wait (Recommended)", "Yes, now"], "OK."],
      ["Should I add tests?", ["No, skip tests (Recommended)", "Add unit tests"], "Fine."],
    ] as const) {
      expect([asked, heard, pick(part(asked, labels), heard)]).toEqual([asked, heard, undefined])
    }
    expect(pick(part("Should I deploy?", ["No, wait (Recommended)", "Yes, now"]), "Sure.")).toEqual(picked(1))
    // What only points at yapd's pick still takes it; "go with that" may point at the option said last, which the model tells.
    expect(["Your pick.", "Go with that.", "The recommended one.", "What you recommend."].map((heard) => pick(cache, heard))).toEqual([picked(0), undefined, picked(0), picked(0)])
    // An okay is the model's to tell, even to a question that asks which.
    expect(["OK.", "Fine.", "Sounds good."].map((heard) => pick(part("Which colour should the test use?", ["Red", "Blue (Recommended)"]), heard))).toEqual([undefined, undefined, undefined])
    // A question that asks which, or names its options, takes a yes as yapd's pick, and a no as which one then, as before.
    const colour = part("Which colour should the test use?", ["Red", "Blue (Recommended)"])
    expect([pick(colour, "Yes."), pick(colour, "No.")]).toEqual([picked(1), { _tag: "Instead" }])
    expect(pick(part("Should we use Red or Blue for the test?", ["Red", "Blue (Recommended)"]), "Yes.")).toEqual(picked(1))
    expect(pick(part("The test needs a colour. So, which one should it use?", ["Red", "Blue (Recommended)"]), "Yes.")).toEqual(picked(1))
    expect(pick(part("Which colour should the test use? Blue matches the theme.", ["Red", "Blue (Recommended)"]), "Yes.")).toEqual(picked(1))
    // An option that is a yes or a no is still what a yes or no picks.
    const invoices = part("Should I migrate the invoices too?", ["Yes, all of them", "No (Recommended)"])
    expect([pick(invoices, "Yes."), pick(invoices, "No.")]).toEqual([picked(0), picked(1)])
  })

  test("a plain yes takes yapd's pick only to a question that plainly asks which, or names its options with 'or': one that may ask whether, however it's put, is the model's", () => {
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    const pick = (asked: string, labels: ReadonlyArray<string>, heard = "Yes.") => Questions.pick(part(asked, labels), heard, { inFull: true, parts: 1 })
    for (const [asked, labels] of [
      ["Should I drop the table, yes or no?", ["Drop it", "Keep it (Recommended)"]],
      ["Drop the table? Yes or no?", ["Drop it", "Keep it (Recommended)"]],
      ["Should I force push or not?", ["Force push", "Open a new branch (Recommended)"]],
      ["Should I force push or no?", ["Force push", "Open a new branch (Recommended)"]],
      ["Should I run the migration now, which locks the table for an hour or so?", ["Run it now", "Wait until tonight (Recommended)"]],
      ["Confirm: drop the users table.", ["Drop it", "Keep it (Recommended)"]],
      ["Should I drop the cache layer", ["Drop it", "Keep it (Recommended)"]],
      ["Why not merge now?", ["Merge now", "Wait for CI (Recommended)"]],
      ["What if I merge now?", ["Merge now", "Wait for CI (Recommended)"]],
      ["What do you think, should I drop the table?", ["Drop it", "Keep it (Recommended)"]],
      ["Which is it, or should I leave the table?", ["Drop it", "Keep it (Recommended)"]],
      ["Should I use Postgres or something else?", ["Postgres", "SQLite (Recommended)"]],
    ] as const) {
      expect([asked, pick(asked, labels)]).toEqual([asked, undefined])
      // Nor is a no to it which one then.
      expect([asked, pick(asked, labels, "No.")]).toEqual([asked, undefined])
    }
    // Asking which, or naming its options with "or", a yes is to yapd's pick, and a no asks which one then.
    for (const [asked, labels] of [
      ["Which colour should the test use?", ["Red", "Blue (Recommended)"]],
      ["When should I deploy?", ["Now", "Tonight (Recommended)"]],
      ["Should we use Red or Blue for the test?", ["Red", "Blue (Recommended)"]],
      ["Should I drop the table or keep it?", ["Drop it", "Keep it (Recommended)"]],
    ] as const) {
      expect([asked, pick(asked, labels), pick(asked, labels, "No.")]).toEqual([asked, picked(1), { _tag: "Instead" }])
    }
  })

  test("a number he says to options named with numbers takes one only as its whole name, never a place, and anything less is the model's", () => {
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    const workers = part("How many parallel workers should the test run use?", ["1 worker", "2 workers", "4 workers (Recommended)", "8 workers"])
    const pick = (heard: string, asked = workers) => Questions.pick(asked, heard, { inFull: true, parts: 1 })
    for (const [heard, index] of [
      ["Eight workers.", 3],
      ["Four workers.", 2],
      ["4 workers.", 2],
      ["The four workers.", 2],
      ["One worker.", 0],
      // A number alone is part of a name, and with names that have numbers, no place is ever one.
      ["Four.", undefined],
      ["4.", undefined],
      ["Two.", undefined],
      ["One.", undefined],
      ["The four one.", undefined],
      ["The fourth one.", undefined],
      ["Option four.", undefined],
      ["Last.", undefined],
      ["Three.", undefined],
      ["Number four.", undefined],
    ] as const) {
      expect([heard, pick(heard)]).toEqual([heard, index === undefined ? undefined : picked(index)])
    }
    // A name that's only a number is its whole name.
    expect(pick("Four.", part("How many workers?", ["1", "2", "4", "8"]))).toEqual(picked(2))
    expect(pick("Three.", part("How many retries?", ["2 retries", "3 retries", "5 retries"]))).toBeUndefined()
    expect(pick("Three retries.", part("How many retries?", ["2 retries", "3 retries", "5 retries"]))).toEqual(picked(1))
    expect(pick("Twenty two.", part("Which Node version?", ["Node 18", "Node 20 (Recommended)", "Node 22"]))).toBeUndefined()
    expect(pick("Node twenty two.", part("Which Node version?", ["Node 18", "Node 20 (Recommended)", "Node 22"]))).toEqual(picked(2))
    const several = part("How many workers?", ["1 worker", "2 workers", "4 workers", "8 workers"], { multiSelect: true })
    expect(Questions.pick(several, "Two and four.", { inFull: true, parts: 1 })).toBeUndefined()
    expect(Questions.pick(several, "Two workers and four workers.", { inFull: true, parts: 1 })).toEqual(picked(1, 2))
    expect(Questions.resolve(workers, "4 workers")).toEqual(picked(2))
    expect(Questions.resolve(workers, "4")).toEqual({ _tag: "Words", text: "4" })
    // Named with numbers in words, as an agent may write them, it's the same: "four" is never the fourth, nor 4 workers.
    const spelled = part("How many parallel workers should the test run use?", ["One worker", "Two workers", "Four workers (Recommended)", "Eight workers"])
    expect(["Four.", "4.", "2.", "4 workers.", "Eight workers."].map((heard) => pick(heard, spelled))).toEqual([undefined, undefined, undefined, picked(2), picked(3)])
    // And a number said in words goes by how it sounds, as in "v two" for v2.
    expect(pick("V two.", part("Which API version?", ["v1", "v2", "v3"]))).toEqual(picked(1))
    // Named with no numbers, a number is a place only said as one, "the blue one" is more than a name, and "one" in a name keeps places off.
    expect(pick("Two.", part("Which colour?", ["Red", "Blue", "Green"]))).toBeUndefined()
    expect(pick("Option two.", part("Which colour?", ["Red", "Blue", "Green"]))).toEqual(picked(1))
    expect(pick("The blue one.", part("Which colour?", ["Red", "Blue", "Green"]))).toBeUndefined()
    expect(pick("Two.", part("Which colour?", ["Red", "Blue", "One more"]))).toBeUndefined()
  })

  test("with a letter, number or place word in any option's name, no place is ever one, and only a whole name picks", () => {
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    const pick = (asked: Questions.Said, heard: string) => Questions.pick(asked, heard, { inFull: true, parts: 1 })
    // Claude lists the one it recommends first.
    const lettered = part("Which approach?", ["Option B (Recommended)", "Option A"])
    expect(["Option A.", "Option B.", "B.", "A.", "The second one."].map((heard) => pick(lettered, heard))).toEqual([picked(1), picked(0), undefined, undefined, undefined])
    const numbered = part("Which approach?", ["Option 2 (Recommended)", "Option 1"])
    expect(["Option one.", "Option 1.", "Option two.", "One.", "Number one.", "The first one."].map((heard) => pick(numbered, heard))).toEqual([
      picked(1),
      picked(1),
      picked(0),
      undefined,
      undefined,
      undefined,
    ])
    const merging = part("How should conflicts be settled?", ["Last write wins (Recommended)", "First write wins", "Manual merge"])
    expect(["First write wins.", "First.", "Last.", "Second.", "The third one.", "The last one.", "Last one.", "The first one."].map((heard) => pick(merging, heard))).toEqual([
      picked(1),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    // Several, each by its letter, is the model's to tell when the names have the letters; by their names, they're what he picked.
    const several = part("Which suites?", ["Option C", "Option A", "Option B"], { multiSelect: true })
    expect(Questions.pick(several, "A and B.", { inFull: true, parts: 1 })).toBeUndefined()
    expect(Questions.pick(several, "Option A and option B.", { inFull: true, parts: 1 })).toEqual(picked(1, 2))
    // A list takes only whole names, never letters or places.
    const suites = part("Which suites?", ["Unit", "Lint", "Types"], { multiSelect: true })
    expect(Questions.pick(suites, "A and C.", { inFull: true, parts: 1 })).toBeUndefined()
    expect(Questions.pick(suites, "Unit and types.", { inFull: true, parts: 1 })).toEqual(picked(0, 2))
  })

  test("a bare number or letter is the model's to tell, since it may be his answer itself, like 'three' to how many: only a place said as one, like 'the second one' or 'option two', is a place", () => {
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    const pick = (asked: Questions.Said, heard: string) => Questions.pick(asked, heard, { inFull: true, parts: 1 })
    for (const [asked, labels, heard] of [
      ["How many retries?", ["Once", "Twice", "Never"], "Three."],
      ["How many retries?", ["None", "A few", "A lot"], "One."],
      ["Which language should the bindings use?", ["Python", "Rust", "Go"], "C."],
      ["How many days of logs should I keep?", ["A week", "A month", "Forever"], "Three."],
      ["How many days of logs should I keep?", ["A week", "A month", "Forever"], "A."],
      ["Which colour?", ["Red", "Blue", "Green"], "2."],
      ["Which colour?", ["Red", "Blue", "Green"], "The two one."],
    ] as const) {
      expect([asked, heard, pick(part(asked, labels), heard)]).toEqual([asked, heard, undefined])
    }
    const colour = part("Which colour?", ["Red", "Blue", "Green"])
    expect(["The second one.", "Second.", "Option two.", "Number 2.", "Option B.", "The third option.", "The former."].map((heard) => pick(colour, heard))).toEqual([
      picked(1),
      picked(1),
      picked(1),
      picked(1),
      picked(1),
      picked(2),
      picked(0),
    ])
    // Nor does a bare number name yapd's pick, said over it before he heard it.
    const retries = part("How many retries?", ["Once", "Twice", "Never (Recommended)"])
    expect(["Three, I think.", "C, I think.", "The third one, I think.", "Option three, I think."].map((heard) => Questions.mentions(retries, 2, heard))).toEqual([false, false, true, true])
  })

  test("'the last one' said before he'd heard them all is the model's to tell, since the last he heard may not be the last there is", () => {
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    const branch = part("What should I do with the branch?", ["Rebase", "Merge", "Squash", "Delete the branch"])
    const pick = (heard: string, inFull: boolean) => Questions.pick(branch, heard, { inFull, parts: 1 })
    expect(["The last one.", "Last.", "The latter.", "The second one."].map((heard) => pick(heard, false))).toEqual([undefined, undefined, undefined, picked(1)])
    expect(["The last one.", "The latter."].map((heard) => pick(heard, true))).toEqual([picked(3), picked(3)])
  })

  test("after a no to yapd's pick, a place counts among the others he was offered, never the pick he turned down", () => {
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    // As the assistant leans it once it's asked "Which one then, sir: Red or Green?".
    const colour = { ...part("Which colour?", ["Blue (Recommended)", "Red", "Green"]), recommended: Option.none<number>(), among: [1, 2] }
    const pick = (asked: Questions.Said, heard: string) => Questions.pick(asked, heard, { inFull: true, parts: 1 })
    expect(["The first one.", "Option one.", "First.", "Option A.", "The second one.", "Option B.", "Last.", "Blue."].map((heard) => pick(colour, heard))).toEqual([
      picked(1),
      picked(1),
      picked(1),
      picked(1),
      picked(2),
      picked(2),
      picked(2),
      picked(0),
    ])
    // A third place, or one past what he was offered, is no place at all, and a bare letter is the model's to tell.
    expect([pick(colour, "The third one."), pick(colour, "Option C."), pick(colour, "A.")]).toEqual([undefined, undefined, undefined])
    // The model's answer only by a whole name.
    expect(Questions.resolve(colour, "Red")).toEqual(picked(1))
    expect(Questions.resolve(colour, "The first one.")).toEqual({ _tag: "Words", text: "The first one." })
    expect(Questions.mentions(colour, 1, "The first one, I think.")).toBe(true)
    expect(Questions.mentions(colour, 0, "The first one, I think.")).toBe(false)
    const extras = { ...part("Which test extras should run?", ["Alpha", "Beta", "Gamma (Recommended)"], { multiSelect: true }), recommended: Option.none<number>(), among: [0, 1] }
    expect(["All of them.", "Both.", "Alpha and Beta.", "The first and the second."].map((heard) => pick(extras, heard))).toEqual([undefined, undefined, picked(0, 1), undefined])
  })

  test("when the question names its options so they aren't read, a place is the model's to tell, since he heard them in the question's order, not the agent's", () => {
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    const pick = (asked: Questions.Said, heard: string) => Questions.pick(asked, heard, { inFull: true, parts: 1 })
    // Claude lists the one it recommends first, so "the first one" he heard is Deploy now, which the agent lists second.
    const deploy = part("Should I deploy now or wait?", ["Wait (Recommended)", "Deploy now"])
    expect(deploy.read).toBe(false)
    for (const heard of ["The first one.", "The latter.", "The former.", "First.", "Second.", "Last.", "Option two.", "Number one.", "A.", "B."]) {
      expect([heard, pick(deploy, heard)]).toEqual([heard, undefined])
    }
    expect([Questions.mentions(deploy, 0, "The first one, I think."), Questions.mentions(deploy, 1, "The latter, I think.")]).toEqual([false, false])
    // By name it's still plain.
    expect(["Deploy now.", "Wait."].map((heard) => pick(deploy, heard))).toEqual([picked(1), picked(0)])
    // Once he's heard the others after a no, it's their order he heard.
    const rollback = { ...part("Should I deploy now, wait or roll back?", ["Wait (Recommended)", "Deploy now", "Roll back"]), recommended: Option.none<number>(), among: [1, 2] }
    expect(rollback.read).toBe(false)
    expect(["The first one.", "The last one."].map((heard) => pick(rollback, heard))).toEqual([picked(1), picked(2)])
  })

  test("options named alike but for their marks, like C++ and C#, go by their names as written, never by a letter's place", () => {
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    const sharp = part("Which language should the bindings use?", ["C++", "C#", "Rust"])
    const plain = part("Which language should the bindings use?", ["C", "C++", "Rust"])
    const pick = (asked: Questions.Said, heard: string) => Questions.pick(asked, heard, { inFull: true, parts: 1 })
    expect(["C#", "C++.", "Rust."].map((heard) => pick(sharp, heard))).toEqual([picked(1), picked(0), picked(2)])
    expect(["C.", "C++"].map((heard) => pick(plain, heard))).toEqual([picked(0), picked(1)])
    // A letter in their names keeps places off: which one is the model's to tell.
    expect(["The first one.", "The second one."].map((heard) => pick(sharp, heard))).toEqual([undefined, undefined])
    // "C" that's both "C++" and "C#" is no one's own, nor the third option's letter: the model's to tell.
    expect(pick(sharp, "C.")).toBeUndefined()
    // What yapd sends back of his pick, or the model's answer, is the option it names as written.
    expect(["C++", "C#", "Rust"].map((text) => Questions.resolve(sharp, text))).toEqual([picked(0), picked(1), picked(2)])
    expect(["C", "C++"].map((text) => Questions.resolve(plain, text))).toEqual([picked(0), picked(1)])
  })

  test("a multi-select answer takes only lists of whole names and 'none' without the model: 'all', 'both' and 'all but X' are the model's, since they take what he may not have heard", () => {
    const extras = part("Which test extras should run?", ["Alpha", "Beta", "Gamma (Recommended)", "Full history"], { multiSelect: true })
    const pick = (heard: string) => Questions.pick(extras, heard, { inFull: true, parts: 2 })
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    expect(pick("Alpha and Gamma.")).toEqual(picked(0, 2))
    expect(pick("Alpha, Beta and full history.")).toEqual(picked(0, 1, 3))
    expect(pick("Gamma plus alpha.")).toEqual(picked(0, 2))
    expect(pick("Alpha, Beta, and Gamma.")).toEqual(picked(0, 1, 2))
    // With what came between them, or before them, lost, or "just" before one, it's the model's.
    expect(pick("Alpha Gamma.")).toBeUndefined()
    expect(pick("And Beta.")).toBeUndefined()
    expect(pick("Just Beta.")).toBeUndefined()
    for (const heard of ["All.", "All of them.", "Everything.", "All but Beta.", "Everything except Beta and full history."]) {
      expect([heard, pick(heard)]).toEqual([heard, undefined])
    }
    // Least of all before he's heard every option, like one that drops a database.
    const steps = part("What should I run?", ["Run tests", "Lint", "Drop the staging database"], { multiSelect: true })
    expect(["All.", "All but lint."].map((heard) => Questions.pick(steps, heard, { inFull: false, parts: 1 }))).toEqual([undefined, undefined])
    expect(pick("Yes.")).toEqual(picked(2))
    expect(pick("None of them.")).toEqual({ _tag: "Words", text: "None of those." })
    expect(Questions.pick(part("Which checks?", ["Lint", "Types"], { multiSelect: true }), "Both.", { inFull: true, parts: 1 })).toBeUndefined()
    expect(pick("Alpha and something else.")).toBeUndefined()
    // Sent as a list straight to the agent, and as one string when T3 Code takes the answer as a message.
    const asked = question(extras.id, ["Alpha", "Beta", "Gamma (Recommended)", "Full history"], { multiSelect: true })
    expect(Questions.answers({ questions: [asked], mode: "live" }, { [asked.id]: { _tag: "Picked", options: [0, 2] } })).toEqual(Either.right({ [asked.id]: ["Alpha", "Gamma (Recommended)"] }))
    expect(Questions.answers({ questions: [asked], mode: "message" }, { [asked.id]: { _tag: "Picked", options: [0, 2] } })).toEqual(Either.right({ [asked.id]: "Alpha, Gamma (Recommended)" }))
  })

  test("the model's answer comes back to the options it names in full, line by line, or else to his own words", () => {
    const colour = part("Which colour should the test use?", ["Red", "Blue (Recommended)"])
    const extras = part("Which test extras should run?", ["Alpha", "Beta", "Gamma"], { multiSelect: true })
    expect(Questions.resolve(colour, "Blue (Recommended)")).toEqual({ _tag: "Picked", options: [1] })
    expect(Questions.resolve(extras, "Alpha\nGamma")).toEqual({ _tag: "Picked", options: [0, 2] })
    expect(Questions.resolve(extras, "Alpha, Gamma")).toEqual({ _tag: "Words", text: "Alpha, Gamma" })
    // Never by part of a name, or a place.
    expect(Questions.resolve(colour, "The blue one")).toEqual({ _tag: "Words", text: "The blue one" })
    expect(Questions.resolve(colour, "The second one")).toEqual({ _tag: "Words", text: "The second one" })
    expect(Questions.resolve(colour, "Blue, but only for the tests.")).toEqual({ _tag: "Words", text: "Blue, but only for the tests." })
    expect(Questions.resolve(colour, "Red\nBlue")).toEqual({ _tag: "Words", text: "Red\nBlue" })
    // An option with more on a line of its own is his words, all of them, never only the option.
    expect(Questions.resolve(colour, "Blue\nbut only for the tests")).toEqual({ _tag: "Words", text: "Blue\nbut only for the tests" })
    expect(Questions.resolve(extras, "Alpha\nGamma\nbut skip them on CI")).toEqual({ _tag: "Words", text: "Alpha\nGamma\nbut skip them on CI" })
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
