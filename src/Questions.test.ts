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

/**
 * Every answer the reviews of the rules before found still sent another
 * option than his without the model: a bare number or letter taken for a
 * place, or a place counted in the order the options were read rather than
 * named; a plain yes to a question that asks whether, however it's put; a
 * no with a stop or a mark after it; a name with what goes without saying
 * left out; "all" before he'd heard them all, and "I don't mind"; a name
 * by how it sounds, hiding a no or joining numbers; a letter for a name
 * with a symbol; and more than a yes or a no to options named Yes and No.
 * Several when he could pick several.
 */
const reviewed: ReadonlyArray<readonly [asked: string, labels: ReadonlyArray<string>, heard: ReadonlyArray<string>, several?: boolean]> = [
  ["How many retries?", ["Once", "Twice", "Never"], ["Three."]],
  ["How many retries?", ["None", "A few", "A lot"], ["One."]],
  ["Which language should the bindings use?", ["Python", "Rust", "Go"], ["C."]],
  ["How many days of logs should I keep?", ["A week", "A month", "Forever"], ["Three.", "A."]],
  ["Should I drop the table, yes or no?", ["Drop it", "Keep it (Recommended)"], ["Yes."]],
  ["Drop the table? Yes or no?", ["Drop it", "Keep it (Recommended)"], ["Yes."]],
  ["Should I force push or not?", ["Force push", "Open a new branch (Recommended)"], ["Yes."]],
  ["Should I run the migration now, which locks the table for an hour or so?", ["Run it now", "Wait until tonight (Recommended)"], ["Yes."]],
  ["Confirm: drop the users table.", ["Drop it", "Keep it (Recommended)"], ["Yes."]],
  ["Should I drop the cache layer", ["Drop it", "Keep it (Recommended)"], ["Yes."]],
  ["Should I run the tests?", ["Tests", "No tests (Recommended)"], ["No, tests.", "Nope, tests.", "No? Tests."]],
  ["Should I merge?", ["Merge", "No merge (Recommended)"], ["No, merge."]],
  ["Should I merge?", ["Merge", "Don't merge"], ["Don't. Merge.", "Don’t, merge."]],
  ["Should I retry?", ["Retry", "Never retry"], ["Never, retry."]],
  ["What should I do?", ["Restart", "Restart yapd"], ["Restart yapd, please.", "Um, restart yapd.", "Restart yapd, sir."]],
  ["What should I do?", ["Voice", "Jarvis voice"], ["Jarvis voice, please."]],
  ["What should I do?", ["Restart", "Restart Jarvis"], ["Restart Jarvis please."]],
  ["What should I do?", ["Hold", "Please hold"], ["Please hold, sir."]],
  ["What should I run?", ["Run tests", "Lint", "Drop the staging database"], ["All.", "All but lint."], true],
  ["What should I do with the branch?", ["Rebase", "Merge", "Squash", "Delete the branch"], ["The last one.", "The latter."]],
  ["Do you mind if I force push?", ["Force push", "Open a new branch (Recommended)"], ["I don't mind."]],
  ["Which changes should go in?", ["Notable changes only", "Everything"], ["Not able changes only."]],
  ["Who should review it?", ["Nobody", "Everyone"], ["No body."]],
  ["What do you think — should I merge now?", ["Merge now", "Wait for CI (Recommended)"], ["Yes."]],
  ["What do you think; should I merge now?", ["Merge now", "Wait for CI (Recommended)"], ["Yes."]],
  ["How does merging now sound?", ["Merge now", "Wait for CI (Recommended)"], ["Yes."]],
  ["What do you say we drop the table?", ["Drop it", "Keep it (Recommended)"], ["Sure."]],
  ["Which is safer — should I drop the users table now?", ["Drop it", "Keep it (Recommended)"], ["Yes."]],
  ["Who should do it — can I go ahead and force push?", ["Force push", "Open a new branch (Recommended)"], ["Yes."]],
  ["When I'm done — delete the branch?", ["Delete it", "Keep it (Recommended)"], ["Yes."]],
  ["How would you feel about dropping the table?", ["Drop it", "Keep it (Recommended)"], ["Yes."]],
  ["Which do you prefer, me force pushing?", ["Force push", "Open a new branch (Recommended)"], ["Yes."]],
  ["Should I run the tests?", ["Tests", "No tests"], ["No - tests.", "No -- tests.", "No / tests.", "No . . . tests.", `No "tests".`, "No (tests).", "No | tests.", "No um tests."]],
  ["Should I merge?", ["Merge", "Don't merge"], ["Don't - merge."]],
  ["Should I merge?", ["Merge", "Do not merge"], ["Do not - merge."]],
  ["Should I retry?", ["Retry", "Never retry"], ["Never - retry."]],
  ["Should I keep backups?", ["Backups", "No backups"], ["No- backups."]],
  ["Which language should the bindings use?", ["C++", "Rust", "Go"], ["C."]],
  ["Which languages should the bindings use?", ["C++", "Rust", "Go"], ["C, Rust."], true],
  ["Which grade?", ["A+", "B"], ["A."]],
  ["Which language?", ["C#", "Java"], ["C."]],
  ["Which language?", ["F#", "OCaml"], ["F."]],
  ["How long should I keep the preview up?", ["1 hour", "2 hours", "12 hours"], ["One, two hours."]],
  ["How many replicas?", ["1 replica", "3 replicas", "13 replicas"], ["One, three replicas."]],
  ["Which version should I pin?", ["Version 1.0", "Version 2.0"], ["Version ten."]],
  ["Which version should I pin?", ["1.0", "2.0"], ["Ten."]],
  ["How many workers?", ["2 workers", "4 workers", "24 workers"], ["Two, four workers."]],
  ["Where should I deploy?", ["Deploy nowhere", "Deploy here"], ["Deploy now, here."]],
  ["Do you mind if I force push?", ["Yes", "No"], ["Don't.", "Sure."]],
  ["Mind if I force push?", ["Yes, go ahead", "No, don't"], ["Nope."]],
  ["Deploy or roll back?", ["Roll back the release", "Deploy anyway"], ["The first one."]],
  ["Should I deploy or roll back?", ["Roll back the release (Recommended)", "Deploy anyway"], ["The first one."]],
  ["What should I do?", ["Cancel deploy", "Deploy"], ["Cancel, deploy."]],
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

  test("an answer is taken without the model only when it's exactly an option's name, in any case and without a full stop after it: anything else is the model's", () => {
    const networks = part("Which network should we start with?", ["Mainnet", "Ghostnet (Recommended)", "Full history", "Shadow testnet"])
    const pick = (heard: string, inFull = true) => Questions.pick(networks, heard, { inFull, parts: 1 })
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    for (const [heard, index] of [
      ["Mainnet.", 0],
      ["mainnet", 0],
      ["MAINNET!", 0],
      ["  Full   history? ", 2],
      // Its "(Recommended)" only marks yapd's pick: the name is the same with it or without.
      ["Ghostnet.", 1],
      ["Ghostnet (Recommended)", 1],
      // Nothing else goes without saying: no "the", "please", "sir" or "uh", no second stop, nor any other mark.
      ["The full history.", undefined],
      ["Full history, please.", undefined],
      ["Shadow testnet, sir.", undefined],
      ["Uh, Mainnet.", undefined],
      ["Mainnet..", undefined],
      ["Mainnet,", undefined],
      // Nor how it sounds, part of it, or more than it.
      ["ghost net", undefined],
      ["Main net.", undefined],
      ["Shadow.", undefined],
      ["The full history one.", undefined],
      ["Ghostnet, but only for the tests.", undefined],
      ["Mainnet and Ghostnet.", undefined],
      // Nor a place, a number or a letter.
      ["The third one.", undefined],
      ["Second.", undefined],
      ["Option 4.", undefined],
      ["Option D.", undefined],
      ["Last.", undefined],
      ["Four.", undefined],
      ["C.", undefined],
      // Nor a plain yes or no, what points at yapd's pick, or leaving it to yapd: the model's told the pick, and whether he heard it.
      ["Yes.", undefined],
      ["No.", undefined],
      ["Sounds good.", undefined],
      ["Your pick.", undefined],
      ["The recommended one.", undefined],
      ["Go with what you recommend.", undefined],
      ["You decide.", undefined],
      ["Up to you.", undefined],
    ] as const) {
      expect([heard, pick(heard)]).toEqual([heard, index === undefined ? undefined : picked(index)])
    }
    // Cut off before yapd said its pick, a yes or a no is the model's too, and an option's name is still that option.
    expect([pick("Yes.", false), pick("No.", false), pick("Mainnet.", false)]).toEqual([undefined, undefined, picked(0)])
    // A letter is an option only when it's that option's name.
    expect(Questions.pick(part("Which plan?", ["A", "B", "Neither"]), "B.", { inFull: true, parts: 1 })).toEqual(picked(1))
    expect(Questions.pick(part("Which grade?", ["B", "A"]), "a", { inFull: true, parts: 1 })).toEqual(picked(1))
    expect(Questions.pick(part("Which plan?", ["A", "Keep going", "Stop"]), "C.", { inFull: true, parts: 1 })).toBeUndefined()
    // Two options named alike are the model's to tell apart.
    expect(Questions.pick(part("Which plan?", ["Plan A", "plan  a"]), "Plan A.", { inFull: true, parts: 1 })).toBeUndefined()
    // With nothing to pick from, a yes or a no is the model's, as is "you decide"; "none of those" is his own words.
    expect(Questions.pick(part("Should I also bump the version?", []), "No.", { inFull: true, parts: 1 })).toBeUndefined()
    expect(Questions.pick(part("Which colour?", ["Red", "Blue"]), "Up to you.", { inFull: true, parts: 1 })).toBeUndefined()
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
    // A form that takes only its options asks which of them, rather than send words it can't take.
    expect(Questions.pick(part("Which colour?", ["Red", "Blue"], { allowCustomAnswer: false }), "Neither.", { inFull: true, parts: 1 })).toEqual({ _tag: "Which" })
  })

  test("an option's exact name stays without the model: 'Blue.', 'Use Postgres.', 'C++.' and 'C.' to C and C++, 'No tests.' but never 'No, tests.', and 'Alpha and Gamma.' of several", () => {
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    const pick = (asked: Questions.Said, heard: string) => Questions.pick(asked, heard, { inFull: true, parts: 1 })
    expect(pick(part("Which colour?", ["Red", "Blue"]), "Blue.")).toEqual(picked(1))
    expect(pick(part("Which database?", ["Use Postgres", "Keep SQLite"]), "Use Postgres.")).toEqual(picked(0))
    const languages = part("Which language should the bindings use?", ["C", "C++", "Rust"])
    expect([pick(languages, "C++."), pick(languages, "C.")]).toEqual([picked(1), picked(0)])
    const tests = part("Should I run the tests?", ["Tests", "No tests (Recommended)"])
    expect([pick(tests, "No tests."), pick(tests, "No, tests.")]).toEqual([picked(1), undefined])
    expect(pick(part("Which test extras should run?", ["Alpha", "Beta", "Gamma"], { multiSelect: true }), "Alpha and Gamma.")).toEqual(picked(0, 2))
  })

  test("every mark in a name counts as it's written, so a symbol, a digit, a comma, a hyphen or an apostrophe of his own, or one he leaves out, is the model's to tell", () => {
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    const pick = (labels: ReadonlyArray<string>, heard: string) => Questions.pick(part("What should I do?", labels), heard, { inFull: true, parts: 1 })
    expect(["C++.", "C.", "c++", "Rust."].map((heard) => pick(["C", "C++", "Rust"], heard))).toEqual([picked(1), picked(0), picked(1), picked(2)])
    expect(["C#", "C++.", "C.", "C sharp."].map((heard) => pick(["C++", "C#", "Rust"], heard))).toEqual([picked(1), picked(0), undefined, undefined])
    expect(["No tests.", "No, tests.", "No - tests.", "No-tests."].map((heard) => pick(["Tests", "No tests (Recommended)"], heard))).toEqual([picked(1), undefined, undefined, undefined])
    expect(["No, skip tests.", "No skip tests."].map((heard) => pick(["No, skip tests", "Run tests"], heard))).toEqual([picked(0), undefined])
    expect(["date-fns.", "date fns.", "datefns."].map((heard) => pick(["date-fns", "Luxon"], heard))).toEqual([picked(0), undefined, undefined])
    expect(["Don't merge.", "Don’t merge.", "Dont merge."].map((heard) => pick(["Merge", "Don't merge"], heard))).toEqual([picked(1), undefined, undefined])
    expect(["4.", "Four."].map((heard) => pick(["2", "4", "8"], heard))).toEqual([picked(1), undefined])
    expect(["Four.", "4."].map((heard) => pick(["Two", "Four", "Eight"], heard))).toEqual([picked(1), undefined])
    // A name that ends in a mark is its name with that mark.
    expect(["Ship it!", "Ship it.", "Ship it"].map((heard) => pick(["Ship it!", "Hold it"], heard))).toEqual([picked(0), undefined, undefined])
  })

  test("a name is never taken by how it sounds, however Whisper writes it, so 'ghost net', 'v two', 'four workers' or 'not able' is the model's to tell", () => {
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    const pick = (labels: ReadonlyArray<string>, heard: string) => Questions.pick(part("What should I do?", labels), heard, { inFull: true, parts: 1 })
    for (const [labels, heard] of [
      [["Mainnet", "Ghostnet"], "Ghost net."],
      [["Day.js", "Luxon"], "Day js."],
      [["v1", "v2", "v3"], "V two."],
      [["1 worker", "4 workers"], "Four workers."],
      [["Node 20", "Node 22"], "Node twenty two."],
      [["OK", "Wait (Recommended)"], "Okay."],
      [["Okay", "Wait (Recommended)"], "OK."],
      [["Cannot reproduce", "Fixed"], "Can not reproduce."],
      [["Notable changes only", "Everything"], "Not able changes only."],
      [["Nobody", "Everyone"], "No body."],
    ] as const) {
      expect([heard, pick(labels, heard)]).toEqual([heard, undefined])
    }
    // As written, each is its name.
    expect([pick(["Mainnet", "Ghostnet"], "Ghostnet."), pick(["v1", "v2", "v3"], "V2."), pick(["OK", "Wait"], "OK."), pick(["Nobody", "Everyone"], "Nobody.")]).toEqual([
      picked(1),
      picked(1),
      picked(0),
      picked(0),
    ])
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
    // An option named exactly is plain, whatever turns it.
    expect(pick(["Red", "Blue"], "Blue.")).toEqual(picked(1))
    expect(pick(["Keep it", "Don't keep it"], "Keep it.")).toEqual(picked(0))
    expect(pick(["Keep it", "Don't keep it"], "Don't keep it.")).toEqual(picked(1))
    expect(pick(["Run tests", "Skip tests"], "Skip tests.")).toEqual(picked(1))
    expect(pick(["Add tests", "No tests"], "No tests.")).toEqual(picked(1))
    expect(pick(["Merge now", "Do not merge now"], "Do not merge now.")).toEqual(picked(1))
    // The model's answer, or his words dictated to the thread, are his own words then, never that option.
    const merge = part("What should I do with the branch?", ["Open a draft pull request (Recommended)", "Do not merge now"])
    expect(Questions.resolve(merge, "Merge now")).toEqual({ _tag: "Words", text: "Merge now" })
    expect(Questions.resolve(merge, "Do not merge now")).toEqual(picked(1))
  })

  test("every answer review found sent another option than his without the model is the model's to tell, or his own words when it comes back", () => {
    for (const [asked, labels, said, several = false] of [...misread, ...reviewed]) {
      const asking = part(asked, labels, { multiSelect: several })
      for (const heard of said) {
        const answers = [Questions.pick(asking, heard, { inFull: true, parts: 1 }), Questions.pick(asking, heard, { inFull: false, parts: 1 }), Questions.resolve(asking, heard)]
        expect([labels, heard, answers]).toEqual([labels, heard, [undefined, undefined, { _tag: "Words", text: heard }]])
      }
    }
    // "Not now" with a stop in it still puts the question off, never sending the option named so.
    const deploy = part("Should I deploy?", ["Now", "Not now"])
    expect(["Not. Now.", "Not - now."].map((heard) => Questions.pick(deploy, heard, { inFull: true, parts: 1 }))).toEqual([{ _tag: "Later" }, { _tag: "Later" }])
  })

  test("a plain yes or no, 'your pick', 'the recommended one' and 'you decide' are the model's to tell, whatever the question asks, and a yes or no takes an option only as its exact name", () => {
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    const pick = (asked: Questions.Said, heard: string, inFull = true) => Questions.pick(asked, heard, { inFull, parts: 1 })
    const agreeing = ["Yes.", "Yeah.", "Sure.", "No.", "Nope.", "OK.", "Fine.", "Go ahead.", "Your pick.", "The recommended one.", "What you recommend.", "You decide.", "Up to you."]
    for (const [asked, labels] of [
      ["Which colour should the test use?", ["Red", "Blue (Recommended)"]],
      ["Should we use Red or Blue for the test?", ["Red", "Blue (Recommended)"]],
      ["Which colour should the test use? Blue matches the theme.", ["Red", "Blue (Recommended)"]],
      ["Should I keep the cache?", ["Drop it (Recommended)", "Keep it"]],
      ["Should I add tests?", ["No, skip tests (Recommended)", "Add unit tests"]],
      ["Should I deploy?", ["No, wait (Recommended)", "Yes, now"]],
      ["Do you mind if I force push?", ["Force push", "Open a new branch (Recommended)"]],
      ["What now?", ["Pause (Recommended)", "Continue the migration"]],
    ] as const) {
      for (const heard of agreeing) {
        expect([asked, heard, pick(part(asked, labels), heard), pick(part(asked, labels), heard, false)]).toEqual([asked, heard, undefined, undefined])
      }
    }
    // Options named Yes and No take a yes or a no only as their names, never another word for one.
    const minding = part("Do you mind if I force push?", ["Yes", "No (Recommended)"])
    expect(["Yes.", "no", "No!", "Yeah.", "Yep.", "Sure.", "Nope.", "Don't.", "Do not.", "No thanks."].map((heard) => pick(minding, heard))).toEqual([
      picked(0),
      picked(1),
      picked(1),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    const invoices = part("Should I migrate the invoices too?", ["Yes, all of them", "No (Recommended)"])
    expect(["Yes.", "Yes, all of them.", "No.", "Nope."].map((heard) => pick(invoices, heard))).toEqual([undefined, picked(0), picked(1), undefined])
    // So no reply is a no to yapd's pick, to ask which one then: only the model, which tells what a no is to, asks that.
    const toPick: [Extract<Questions.Reply, { readonly _tag: "Instead" }>] extends [never] ? true : false = true
    expect(toPick).toBe(true)
    // A yes with words after it, or words to go ahead, are the model's however they start another option's name.
    for (const [labels, heard] of [
      [["Ship it now", "Hold it for QA (Recommended)"], "Ship it."],
      [["Proceed with the migration", "Wait for review (Recommended)"], "Proceed."],
      [["Go ahead with the rename", "Keep the old name (Recommended)"], "Sure, go ahead."],
      [["Do it again", "Mark it skipped (Recommended)"], "Yes, do it."],
      [["Agreed, ship it", "Revise first (Recommended)"], "Agreed."],
      [["Okay, ship it", "Wait (Recommended)"], "OK."],
      [["Wait for CI (Recommended)", "Squash and merge"], "Yes, merge it."],
      [["Merge now (Recommended)", "Wait for CI"], "Yes, merge it."],
    ] as const) {
      expect([heard, pick(part("What now?", labels), heard)]).toEqual([heard, undefined])
    }
  })

  test("a place, by any words, and a number or a letter that isn't a name are the model's to tell, as is his saying one over yapd's pick before he heard it", () => {
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    const pick = (asked: Questions.Said, heard: string, inFull = true) => Questions.pick(asked, heard, { inFull, parts: 1 })
    const colour = part("Which colour?", ["Red", "Blue", "Green"])
    for (const heard of ["The second one.", "Second.", "Option two.", "Number 2.", "Option B.", "The third option.", "The former.", "The last one.", "The latter.", "Two.", "2.", "B.", "The two one.", "The blue one."]) {
      expect([heard, pick(colour, heard), pick(colour, heard, false)]).toEqual([heard, undefined, undefined])
    }
    // Named with numbers or letters, only the name as written is one.
    const workers = part("How many parallel workers should the test run use?", ["1 worker", "2 workers", "4 workers (Recommended)", "8 workers"])
    expect(["4 workers.", "4 workers", "Four workers.", "Four.", "4.", "The fourth one.", "Option four."].map((heard) => pick(workers, heard))).toEqual([
      picked(2),
      picked(2),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(["Node 22.", "Node twenty two.", "Twenty two."].map((heard) => pick(part("Which Node version?", ["Node 18", "Node 20 (Recommended)", "Node 22"]), heard))).toEqual([
      picked(2),
      undefined,
      undefined,
    ])
    const lettered = part("Which approach?", ["Option B (Recommended)", "Option A"])
    expect(["Option A.", "Option B.", "B.", "A.", "The second one."].map((heard) => pick(lettered, heard))).toEqual([picked(1), picked(0), undefined, undefined, undefined])
    const numbered = part("Which approach?", ["Option 2 (Recommended)", "Option 1"])
    expect(["Option 1.", "Option one.", "One.", "The first one."].map((heard) => pick(numbered, heard))).toEqual([picked(1), undefined, undefined, undefined])
    const merging = part("How should conflicts be settled?", ["Last write wins (Recommended)", "First write wins", "Manual merge"])
    expect(["First write wins.", "First.", "Last.", "The last one."].map((heard) => pick(merging, heard))).toEqual([picked(1), undefined, undefined, undefined])
    expect(Questions.resolve(workers, "4 workers")).toEqual(picked(2))
    expect(Questions.resolve(workers, "4")).toEqual({ _tag: "Words", text: "4" })
    expect(Questions.resolve(colour, "The second one")).toEqual({ _tag: "Words", text: "The second one" })
    // Said over yapd's pick before he heard it, only its exact name among his words names it, never with a no, a place or a number.
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
    const retries = part("How many retries?", ["Once", "Twice", "Never (Recommended)"])
    expect(["Three, I think.", "C, I think.", "The third one, I think.", "Option three, I think."].map((heard) => Questions.mentions(retries, 2, heard))).toEqual([false, false, false, false])
  })

  test("of several, only exact names joined by ', ' or ' and ', each a different option's, are taken without the model: 'all', 'both', 'just Beta' or names alike are the model's", () => {
    const extras = part("Which test extras should run?", ["Alpha", "Beta", "Gamma (Recommended)", "Full history"], { multiSelect: true })
    const pick = (heard: string) => Questions.pick(extras, heard, { inFull: true, parts: 2 })
    const picked = (...options: ReadonlyArray<number>): Questions.Reply => ({ _tag: "Picked", options })
    expect(pick("Alpha and Gamma.")).toEqual(picked(0, 2))
    expect(pick("gamma and alpha")).toEqual(picked(0, 2))
    expect(pick("Alpha, Beta and full history.")).toEqual(picked(0, 1, 3))
    expect(pick("Alpha, Gamma, Full history")).toEqual(picked(0, 2, 3))
    expect(pick("Beta.")).toEqual(picked(1))
    for (const heard of [
      "Alpha, Beta, and Gamma.",
      "Gamma plus alpha.",
      "Alpha & Gamma.",
      "Alpha; Gamma.",
      "Alpha,Gamma.",
      "Alpha Gamma.",
      "Alpha and Alpha.",
      "And Beta.",
      "Just Beta.",
      "Alpha and something else.",
      "All.",
      "All of them.",
      "Everything.",
      "All but Beta.",
      "Everything except Beta and full history.",
      "Both.",
      "Yes.",
      "A and C.",
      "The first and the second.",
    ]) {
      expect([heard, pick(heard)]).toEqual([heard, undefined])
    }
    expect(pick("None of them.")).toEqual({ _tag: "Words", text: "None of those." })
    // Names a list may be read as two ways are the model's to tell.
    const checks = part("Which checks should run?", ["Lint and tests", "Lint", "Tests"], { multiSelect: true })
    expect(["Lint and tests.", "Lint.", "Lint, tests."].map((heard) => Questions.pick(checks, heard, { inFull: true, parts: 1 }))).toEqual([undefined, picked(1), picked(1, 2)])
    const skipping = part("Which checks should run?", ["Lint", "Tests", "Skip docs"], { multiSelect: true })
    expect(["Lint and skip docs.", "Lint and docs.", "All but skip docs."].map((heard) => Questions.pick(skipping, heard, { inFull: true, parts: 1 }))).toEqual([picked(0, 2), undefined, undefined])
    const lettered = part("Which suites?", ["Option C", "Option A", "Option B"], { multiSelect: true })
    expect(["Option A and option B.", "A and B."].map((heard) => Questions.pick(lettered, heard, { inFull: true, parts: 1 }))).toEqual([picked(1, 2), undefined])
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
    // Never by part of a name, a place, how it sounds, or with a mark or a word of its own.
    expect(Questions.resolve(colour, "The blue one")).toEqual({ _tag: "Words", text: "The blue one" })
    expect(Questions.resolve(colour, "The second one")).toEqual({ _tag: "Words", text: "The second one" })
    expect(Questions.resolve(colour, "Blue, but only for the tests.")).toEqual({ _tag: "Words", text: "Blue, but only for the tests." })
    expect(Questions.resolve(colour, "Red\nBlue")).toEqual({ _tag: "Words", text: "Red\nBlue" })
    expect(Questions.resolve(part("What should I do?", ["Tests", "No tests"]), "No, tests")).toEqual({ _tag: "Words", text: "No, tests" })
    expect(Questions.resolve(part("What should I do?", ["Mainnet", "Ghostnet"]), "Ghost net")).toEqual({ _tag: "Words", text: "Ghost net" })
    // An option with more on a line of its own is his words, all of them, never only the option.
    expect(Questions.resolve(colour, "Blue\nbut only for the tests")).toEqual({ _tag: "Words", text: "Blue\nbut only for the tests" })
    expect(Questions.resolve(extras, "Alpha\nGamma\nbut skip them on CI")).toEqual({ _tag: "Words", text: "Alpha\nGamma\nbut skip them on CI" })
    expect(Questions.resolve(colour, " ")).toEqual({ _tag: "Again" })
    expect(Questions.resolve(part("Which colour?", ["Red", "Blue"], { allowCustomAnswer: false }), "Green.")).toEqual({ _tag: "Which" })
    // What yapd sends back of an option is its name as the agent wrote it, which is always that option, marks and all.
    const sharp = part("Which language should the bindings use?", ["C++", "C#", "Rust"])
    const plain = part("Which language should the bindings use?", ["C", "C++", "Rust"])
    expect(["C++", "C#", "Rust"].map((text) => Questions.resolve(sharp, text))).toEqual([picked(0), picked(1), picked(2)])
    expect(["C", "C++"].map((text) => Questions.resolve(plain, text))).toEqual([picked(0), picked(1)])
    const written = ['"main".', "`date-fns`", "Ship it!", "Use Postgres (Recommended)"]
    const named = part("Which one?", written)
    expect(written.map((text) => Questions.resolve(named, text))).toEqual([picked(0), picked(1), picked(2), picked(3)])
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
