import { Either, Option } from "effect"
import * as Brain from "./Brain.ts"
import { english } from "./Condenser.ts"
import { addressed, type Lines } from "./Persona.ts"
import { agreed, enough, gist } from "./Responder.ts"
import * as T3Actions from "./T3Actions.ts"
import type * as Threads from "./Threads.ts"

// How a thread's question is put to the user by voice, and what he says back
// comes to. It's read in the agent's own words whenever they can be said, so
// asking it takes no model call: only a part that can't be is put otherwise,
// by the model, before it comes here. Each part is asked on its own, with its
// options in the agent's order, and the one the agent recommends said as
// yapd's own pick. His answer is taken as an option without the model only
// when it's that option's whole name, as written, as compared or by how it
// sounds, its place, or a plain yes to yapd's pick; anything else, like part
// of a name or its words in another order, is the model's to make out, and
// what isn't an option's whole name then is his own words, which go to the
// agent as he said them, since it asked him, not a form.

/** A part of a thread's question, as T3 Code shows it. */
export type Question = Extract<T3Actions.Request, { readonly _tag: "Question" }>["questions"][number]

/** An option as it's said, and what answering with it sends. */
export interface Choice {
  /** As it's said: "Blue", or "option two, keep the cache" for one whose name can't be. */
  readonly said: string
  /** As the agent wrote it, which is what's sent. */
  readonly label: string
  /** What's sent in its place, when it isn't the label, as some forms have. */
  readonly value?: string | undefined
  /** What it means, as it's said, when that can be: the first sentence of what the agent wrote of it. */
  readonly meaning: Option.Option<string>
  /** What it goes by: its name, what it means when its name can't be said, or only its number when neither can. */
  readonly by: "label" | "meaning" | "number"
}

/** A part of a thread's question, as it's said. */
export interface Said {
  /** The part's own id, which its answer goes under. */
  readonly id: string
  /** The question, as it's said, or "" when only its options are. */
  readonly question: string
  readonly options: ReadonlyArray<Choice>
  /** The one option the agent recommends, said as yapd's own pick. None when it recommends none, or several. */
  readonly recommended: Option.Option<number>
  /** Whether the options are read out after the question: not when they're Yes and No, nor when the question names them already. */
  readonly read: boolean
  /** Whether the options' names say nothing, like "Option A" and "Option B", so they're read with what they mean. */
  readonly opaque: boolean
  /** Whether several can be picked. */
  readonly several: boolean
  /** Whether it takes his own words, not only an option. */
  readonly ownWords: boolean
  /**
   * The options he was offered last, by their place in the part, when that
   * isn't all of them: the others, once he's turned down yapd's pick. A
   * place or "all" counts among these, as he heard them.
   */
  readonly among?: ReadonlyArray<number> | undefined
}

/** How one part is put to him, each time it comes up. */
export interface Wording {
  readonly part: Said
  /** As it's first asked: the question's opening line for the first part, as it's brought back for the others. */
  readonly first: string
  /** After he answered the part before, as `ack` says he did: for a part with more after it. */
  readonly next: (ack: string) => string
  /** After he answered the part before, for the last part. */
  readonly last: (ack: string) => string
  /** When he asks to hear it again, which doesn't use up an ask: each once. */
  readonly again: ReadonlyArray<string>
  /** When it went unanswered, a minute on: each once. */
  readonly still: ReadonlyArray<string>
  /** Brought back, on his asking, after "later" or after something took its place: from the start, or from this part when he'd answered those before. */
  readonly here: string
  /** Its options, with what each means, when he asks what they are. */
  readonly more: string
  /** After a plain no to yapd's pick: which one then, of the others. */
  readonly instead: string
  /** After words a form that takes only its options can't take: which one, of them all, with yapd's pick. */
  readonly which: string
  /** After he skipped it, when T3 Code needs an answer to it: asked once more, saying so. */
  readonly needed: string
  /** When it's let go unanswered: it still waits for him, and he can ask for it. */
  readonly letGo: string
  /** What its options are called, as written and as said, for speech recognition to know them. */
  readonly terms: ReadonlyArray<string>
}

/** How a question is put to him: asked, a part at a time, or only told, as it waits for him in T3 Code. */
export type Worded =
  | { readonly _tag: "Ask"; readonly parts: ReadonlyArray<Wording> }
  /** Only told: in these words, or, when nothing of it can be said, only that it's there. */
  | { readonly _tag: "Tell"; readonly spoken: Option.Option<string> }

/** What his words to a part come to. */
export type Reply =
  /** The options he picked, by their place in the part: one, or several when it takes several. */
  | { readonly _tag: "Picked"; readonly options: ReadonlyArray<number> }
  /** His own words, which go to the agent as its answer. */
  | { readonly _tag: "Words"; readonly text: string }
  /** He leaves this part unanswered and goes on to the next. */
  | { readonly _tag: "Skip" }
  /** He wants to hear it again in full, which doesn't use up an ask. */
  | { readonly _tag: "Again" }
  /** He wants to know what the options mean. */
  | { readonly _tag: "More" }
  /** A plain no to yapd's pick: which one then, of the others. */
  | { readonly _tag: "Instead" }
  /** Words a form that takes only its options can't take: which of them, then. */
  | { readonly _tag: "Which" }
  /** He wants it put off. */
  | { readonly _tag: "Later" }
  /** He wants it let go. */
  | { readonly _tag: "Leave" }

/** An answer to a part, kept until every part has one and they're sent together. */
export type Answer = Extract<Reply, { readonly _tag: "Picked" | "Words" | "Skip" }>

/** The most options a part, or parts a question, can have to be asked by voice: more is too many to take in. */
export const most = 4

/** How many words a question, an option's name and what it means can have to be said as they are. */
const longest = { question: 30, label: 8, meaning: 20, standIn: 12 }

/** A desk with nothing on it, since a question never names a thread by its handle. */
const nowhere: Threads.Desk = { threads: [], away: [] }

/**
 * The agent's words with the work never put down to an agent or a session.
 * Only when they name one, since what's like a handle in them, as in
 * "t3.small", is the agent's own and not one to make "that one".
 */
const fit = (text: string) => (/\b(?:agent|session)s?\b/i.test(text) ? Brain.speakable(text, nowhere) : text)

/** Small counts as words. */
const numbers = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"]
const counted = (count: number) => numbers[count] ?? String(count)

const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

/** "A", "A or B", "A, B or C". */
const either = (names: ReadonlyArray<string>) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`)

/** "A", "A and B", "A, B and C". */
const both = (names: ReadonlyArray<string>) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`)

/** What only reads, said as it's spoken. */
const spelled: ReadonlyArray<readonly [RegExp, string]> = [
  [/\be\.g\./gi, "for example"],
  [/\bi\.e\./gi, "that is"],
  [/\bvs\.?(?=\s)/gi, "versus"],
  [/\s&\s/g, " and "],
]

/** As it's said: no code marks, no quotes around words, abbreviations spelled out, and single spaces. */
const normal = (text: string) =>
  spelled
    .reduce((said, [pattern, instead]) => said.replace(pattern, instead), text.replace(/`/g, ""))
    .replace(/(^|[\s(])["“”'‘’]([^"“”'‘’\n]+?)["“”'‘’](?=$|[\s,.;:!?)])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim()

/** What reads like a sentence once said: letters, digits and the marks speech has, never a slash, an underscore or a brace. */
const plainly = /^[\p{L}\p{N} ,.'’:;!?()%+–—-]+$/u

/** Whether it can be said as it is, in at most `words` words. */
const sayable = (text: string, words: number) => text !== "" && plainly.test(text) && Brain.readable(text) && english(text) && text.split(" ").length <= words

/**
 * A part's question as it's said, in the agent's own words, when they can
 * be: none when they can't, like one with a path, a link or code in it, or
 * a long one, which the model puts otherwise.
 */
export const sayQuestion = (text: string): Option.Option<string> => {
  const said = normal(text)
  return sayable(said, longest.question) ? Option.some(fit(said)) : Option.none()
}

/** How a recommended option is marked: "(Recommended)", "[Recommended]" or "- recommended", at its end. */
const recommending = /\s*(?:\(\s*recommended\s*\)|\[\s*recommended\s*\]|\s[-–—]\s*recommended)\s*$/i

/** An option's name without its mark, as written. */
const unmarked = (label: string) => label.replace(recommending, "").replace(/`/g, "").trim()

/** The words a sentence starts with that it doesn't need a capital for, said after a colon or a comma. */
const ordinary = /^(The|A|An|It|Its|This|That|These|Those|There|No|Nothing|Something|Your|Our|Only|Just|Keep|Use|Uses|Drop|Drops|Run|Runs|Skip|Skips|Leave|Leaves|Make|Makes|Add|Adds)\b/

/**
 * What an option means, as it's said, when it can be: the first sentence of
 * what the agent wrote of it, cut to twenty words.
 */
export const sayDescription = (description: string): Option.Option<string> => {
  const sentence = (normal(description).split(/(?<=[.!?])\s/)[0] ?? "").replace(/[.!?;:,]+$/, "")
  const cut = sentence.split(" ").slice(0, longest.meaning).join(" ").replace(/[,;:]$/, "")
  if (!sayable(cut, longest.meaning)) return Option.none()
  return Option.some(fit(cut.replace(ordinary, (word) => word.toLowerCase())))
}

/**
 * An option's name as it's said, and whether the agent recommends it: its
 * mark, code marks, quotes and the full stop after it dropped; or, when that
 * can't be said, what it means, short, after its number, or only its number.
 */
export const sayLabel = (label: string, index: number, description: string): { readonly said: string; readonly recommended: boolean; readonly by: Choice["by"] } => {
  const recommended = recommending.test(label)
  const named = normal(label.replace(recommending, "")).replace(/[.!?,;:]+$/, "")
  if (sayable(named, longest.label)) return { said: fit(named), recommended, by: "label" }
  const numbered = `option ${counted(index + 1)}`
  return Option.match(
    Option.filter(sayDescription(description), (meaning) => meaning.split(" ").length <= longest.standIn),
    {
      onNone: () => ({ said: numbered, recommended, by: "number" as const }),
      onSome: (meaning) => ({ said: `${numbered}, ${meaning}`, recommended, by: "meaning" as const }),
    },
  )
}

/** Names that say nothing of what an option is, like "Option A", "Plan 2" or "B". */
const opaqueName = /^(?:(?:option|choice|approach|plan|path|variant)\s*)?(?:[a-d]|[1-4]|one|two|three|four)$/i

/** The header a part has when the agent gave it none, like Codex's "Question 2". */
const unnamed = /^question\s*\d*$/i

/** Words as they're compared, apostrophes kept, as what he says is. */
const wordsOf = (text: string) => new Set(gist(text).split(" "))

/**
 * A part as it's said, from what it is and its question as it's said, the
 * agent's own words or the model's, if either can be: else "About" its
 * header, when the agent gave it one that can be said.
 */
export const said = (question: Question, spoken: Option.Option<string>): Said => {
  const options = question.options.map(({ label, value, description }, index) => ({ ...sayLabel(label, index, description), label, value, meaning: sayDescription(description) }))
  const marked = options.flatMap(({ recommended }, index) => (recommended ? [index] : []))
  const header = normal(question.header).replace(/[.!?:]+$/, "")
  // It follows "About", so it starts as the rest of a sentence, unless it's a name like "API key".
  const about =
    header !== "" && !unnamed.test(header) && sayable(header, 4)
      ? Option.some(`About ${header.replace(/^\p{Lu}(?=\p{Ll})/u, (letter) => letter.toLowerCase())}:`)
      : Option.none<string>()
  const asked = Option.getOrElse(Option.orElse(spoken, () => about), () => "")
  const names = options.map(({ said }) => gist(said))
  const yesOrNo = names.length === 2 && names.includes("yes") && names.includes("no")
  const inQuestion = wordsOf(asked)
  const named = options.every(({ said }) => [...wordsOf(said)].every((word) => inQuestion.has(word)))
  return {
    id: question.id,
    question: asked,
    options: options.map(({ said, label, value, meaning, by }) => ({ said, label, value, meaning, by })),
    recommended: marked.length === 1 ? Option.fromNullable(marked[0]) : Option.none(),
    read: options.length > 0 && (asked === "" || !(yesOrNo || named)),
    opaque: options.length > 0 && options.every(({ label }) => opaqueName.test(normal(unmarked(label)).replace(/[.!?,;:]+$/, ""))),
    several: question.multiSelect,
    ownWords: question.allowCustomAnswer,
  }
}

/** The option yapd says it would go with, if the agent recommends one. */
const recommendedOf = (part: Said) => Option.flatMap(part.recommended, (index) => Option.fromNullable(part.options[index]))

/** Yapd's own pick, after the question: " I'd go with Blue.", or " I'd say yes." to a yes or no. */
const leaning = (part: Said) =>
  Option.match(recommendedOf(part), {
    onNone: () => "",
    onSome: ({ said }) => (/^yes$/i.test(said) ? " I'd say yes." : /^no$/i.test(said) ? " I'd say no." : ` I'd go with ${said}.`),
  })

/** The options, as they're read after the question. */
const offered = (part: Said) => {
  const names = part.options.map(({ said }) => said)
  // Names that say nothing go with what they mean: "Option A, keep the cache; option B, drop it".
  if (part.opaque && part.options.some(({ meaning }) => Option.isSome(meaning))) {
    return part.options
      .map(({ said, meaning }, index) => {
        const name = index === 0 ? said : said.replace(/^\p{Lu}(?=\p{Ll})/u, (letter) => letter.toLowerCase())
        return `${name}${Option.match(meaning, { onNone: () => "", onSome: (meaning) => `, ${meaning}` })}`
      })
      .join("; ")
  }
  if (!part.several) return either(names)
  return names.length === 2 ? `${names[0]}, ${names[1]} or both` : `Any of ${both(names)}`
}

/** A part as it's asked: its question, its options when they're read, and yapd's pick. */
const asked = (part: Said) => {
  const question = part.question === "" || /[.?!:]$/.test(part.question) ? part.question : `${part.question}?`
  const options = part.read ? `${offered(part)}?` : ""
  return `${[question, options].filter((text) => text !== "").join(" ")}${leaning(part)}`
}

/** "Which one" or, when several can be picked, "Which of them". */
const which = (part: Said) => (part.several ? "Which of them" : "Which one")

/** Its options, each with what it means, then yapd's pick, and which he wants. */
const explained = (part: Said, sir: string) => {
  if (part.options.length === 0) return `It gave no options${sir}, so any answer will do: ${asked(part)}`
  const each = part.options.map(({ said, meaning, by }) =>
    by === "meaning" ? `${capital(said)}.` : `${by === "number" ? capital(said) : said}${Option.match(meaning, { onNone: () => "", onSome: (meaning) => `: ${meaning}` })}.`,
  )
  return `${each.join(" ")}${leaning(part)} ${which(part)}${sir}?`
}

/** Which one then, of the options but yapd's pick: "Which one then, sir: Red or Green?", or "Red then, sir?" when one's left. */
const otherwise = (part: Said, sir: string) => {
  const others = part.options.filter((_, index) => !Option.contains(part.recommended, index)).map(({ said }) => said)
  if (others.length === 0) return `What shall I tell it then${sir}?`
  return others.length === 1 ? `${others[0]} then${sir}?` : `${which(part)} then${sir}: ${either(others)}?`
}

/** Which one it takes, of them all, with yapd's pick: "Which one, sir: Red or Blue? I'd go with Blue." */
const choosing = (part: Said, sir: string) => {
  if (part.options.length === 0) return asked(part)
  const options = part.several ? either(part.options.map(({ said }) => said)) : offered(part)
  return `${which(part)}${sir}: ${options}?${leaning(part)}`
}

/**
 * How each part of a question asked of `called` is put to him, or what's
 * told when it can't be asked: too many parts or options to take in, or
 * nothing of it that can be said, like a part with no words and no options,
 * or options mostly known only by their number.
 */
export const worded = (input: { readonly called: string; readonly parts: ReadonlyArray<Said>; readonly lines: Lines }): Worded => {
  const { called, parts, lines } = input
  const sir = addressed(lines)
  const told = (spoken: string): Worded => ({ _tag: "Tell", spoken: Option.some(spoken) })
  const nothing: Worded = { _tag: "Tell", spoken: Option.none() }
  if (parts.length === 0) return nothing
  if (parts.length > most) return told(`${capital(counted(parts.length))} questions on ${called}${sir}: that's too many to ask you one at a time, so they're waiting for you in T3 Code.`)
  const crowded = parts.find(({ options }) => options.length > most)
  if (crowded !== undefined) {
    if (crowded.question === "") return nothing
    const question = asked({ ...crowded, read: false, recommended: Option.none() })
    return told(`A question on ${called}${sir}: ${question} It has ${counted(crowded.options.length)} options, so it's waiting for you in T3 Code.`)
  }
  const unsaid = (part: Said) => (part.question === "" && part.options.length === 0) || part.options.filter(({ by }) => by === "number").length * 2 > part.options.length
  if (parts.some(unsaid)) return nothing
  const count = parts.length
  return {
    _tag: "Ask",
    parts: parts.map((part, index): Wording => {
      const line = asked(part)
      const here =
        index === 0
          ? count === 1
            ? `Here's the question on ${called}${sir}: ${line}`
            : `Here are the ${counted(count)} questions on ${called}${sir}. First: ${line}`
          : index === count - 1
            ? `Here's the last question on ${called}${sir}: ${line}`
            : `Here's the rest of the questions on ${called}${sir}. Next: ${line}`
      const opening = count === 1 ? `A question on ${called}${sir}: ${line}` : `${capital(counted(count))} questions on ${called}${sir}. First: ${line}`
      const names = part.options.flatMap(({ label, said, by }) => (by === "label" ? [unmarked(label), said] : []))
      return {
        part,
        first: index === 0 ? opening : here,
        next: (ack) => `${ack}${sir}. Next: ${line}`,
        last: (ack) => `${ack}${sir}. And last: ${line}`,
        again: [`Again${sir}: ${line}`, `Once more${sir}: ${line}`, `Here it is again${sir}: ${line}`],
        still: [`Back to ${called}${sir}: ${line}`, `${capital(called)} still needs an answer${sir}: ${line}`],
        here,
        more: explained(part, sir),
        instead: otherwise(part, sir),
        which: choosing(part, sir),
        needed: `That one needs an answer${sir}: ${line}`,
        letGo: `I'll leave the question on ${called} for now${sir}; ask me for it when you're ready.`,
        terms: [...new Set(names.filter((name) => name !== ""))],
      }
    }),
  }
}

/** The options picked, as they're said: "Red", "Alpha and Gamma". */
export const spoken = (part: Said, options: ReadonlyArray<number>) => both(options.flatMap((index) => Option.toArray(Option.fromNullable(part.options[index]?.said))))

/** What an answer to a part was, as it's said before the next: the options picked, "Noted" for his own words, or "Skipped". */
export const ack = (part: Said, answer: Answer) => (answer._tag === "Picked" ? spoken(part, answer.options) : answer._tag === "Words" ? "Noted" : "Skipped")

// ---------------------------------------------------------------- answers

/** Numbers as words, up to nineteen, and the tens after. */
const units: Readonly<Record<string, number>> = Object.fromEntries(
  [...numbers, "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"].map((word, count) => [word, count]),
)
const tens: Readonly<Record<string, number>> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }

/**
 * Words as compared, with the numbers in them as figures: "four workers" is
 * "4 workers" and "twenty two" is "22", as Whisper writes them either way.
 * "One" only when it's all there is, comes first, as in "one worker", or
 * follows what it numbers, as in "option one": in "the blue one" it only
 * points. "Okay" is "ok", which Whisper writes too.
 */
const figures = (said: string) => {
  const words = said.split(" ")
  return words
    .flatMap((word, index) => {
      if (word === "okay") return ["ok"]
      const ten = tens[word]
      const unit = units[words[index + 1] ?? ""] ?? 0
      if (ten !== undefined) return [String(ten + (unit > 0 && unit < 10 ? unit : 0))]
      const previous = tens[words[index - 1] ?? ""]
      const count = units[word]
      // The unit of "twenty two" is in the 22 already.
      if (previous !== undefined && count !== undefined && count > 0 && count < 10) return []
      const numbering = /^(?:option|choice|number|plan|tier|version)$/.test(words[index - 1] ?? "")
      return count !== undefined && (word !== "one" || index === 0 || numbering) ? [String(count)] : [word]
    })
    .join(" ")
}

/** How words as compared sound, spaces and marks aside: "ghost net" is Ghostnet, "day js" is Day.js, "four workers" is 4 workers. */
const sound = (said: string) => figures(said).replace(/[^\p{L}\p{N}]+/gu, "")

/**
 * A name as compared, every word of it kept, even one `gist` leaves out of
 * what he says, like "please" in "Please hold" or yapd's own name in
 * "Restart yapd": only his words may go without those.
 */
const kept = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim()

/** Without a "the" before it, which says nothing of which. */
const unled = (said: string) => said.replace(/^the (?=\S)/, "")

/** The places of the options that fit, which settle it only when there's one. */
const fitting = (part: Said, fits: (choice: Choice) => boolean) => part.options.flatMap((choice, index) => (fits(choice) ? [index] : []))
const one = (indices: ReadonlyArray<number>) => (indices.length === 1 ? indices[0] : undefined)

/** As it's compared word for word, marks and all: single spaces, any case, and no full stop after it. */
const verbatim = (text: string) => text.replace(/\s+/g, " ").trim().replace(/[.!?,;:]+$/, "").toLowerCase()

/**
 * The option whose name is just what he or the model wrote, marks and all,
 * like "C#" or "C++", which `gist` makes both "c": what yapd itself sends
 * back as an option is always its name as written.
 */
const exactly = (part: Said, text: string) => {
  const wanted = verbatim(text)
  return wanted === "" ? undefined : one(fitting(part, ({ label, said }) => [label, unmarked(label), said].some((name) => verbatim(name) === wanted)))
}

/**
 * The options his words are the whole name of, nothing of it left out and
 * nothing added: as written, marks and all, which tells "C#" from "C++";
 * else as compared, in any case and with any punctuation, its
 * "(Recommended)", a "the" before it and a "please" or "sir" after it
 * aside; else by how it sounds, as Whisper may write it, like "ghost net"
 * for Ghostnet or "four workers" for 4 workers. More than one when they're
 * named alike, which only the model can tell apart. Part of a name, a word
 * of it, or its words in another order are never one: "merge now" is never
 * "Do not merge now", "just lint" never "Tests and lint", and "the code,
 * not the test" never "Fix the test, not the code".
 */
const wholly = (part: Said, heard: string): ReadonlyArray<number> => {
  const exact = exactly(part, heard)
  if (exact !== undefined) return [exact]
  // His words without "uh", "please", "sir" or yapd's name, or with every word kept, for a name that has them.
  const his = [...new Set([gist(heard), kept(heard)].map(unled))].filter((said) => said !== "")
  if (his.length === 0) return []
  const names = ({ label, said }: Choice) => [label, unmarked(label), said].map((name) => unled(kept(name)))
  const compared = fitting(part, (choice) => names(choice).some((name) => his.includes(name)))
  if (compared.length > 0) return compared
  const sounds = his.map(sound).filter((said) => said !== "")
  return fitting(part, (choice) => names(choice).some((name) => sounds.includes(sound(name))))
}

/** The one option his words are the whole name of, when only one is. */
const whole = (part: Said, heard: string) => one(wholly(part, heard))

/** Whether what he said is one option's whole name, as `wholly` has it, like "Cancel the run". */
export const names = (part: Said, heard: string) => whole(part, heard) !== undefined

/**
 * Whether an option's name starts with these words, as written or as said,
 * like "Cancel the deploy" with "cancel". It never takes an option: it only
 * leaves what he said to the model.
 */
export const opens = (part: Said, heard: string) => {
  const said = gist(heard)
  if (said === "") return false
  const words = `${figures(said)} `
  return part.options.some(({ label, said: name }) => [unmarked(label), name].some((written) => `${figures(gist(written))} `.startsWith(words)))
}

/**
 * An option by its place, said as one: "the second one", "last", "option
 * two", "number 2" or "option B". Never a bare number or letter, like
 * "three" to how many retries or "C" to which language, which may be what
 * he means itself: the model tells.
 */
const place = /^(?:the )?(?:(first|second|third|fourth|last|latter|former|1st|2nd|3rd|4th)(?: one| option)?|(?:option|number|choice) (one|two|three|four|[1-4])|(?:option|choice) ([a-d]))$/

/** The places said in words, which say nothing else. */
const placed: Readonly<Record<string, number>> = { first: 0, former: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3 }

/** The places by a number or a letter, only ever after "option", "number" or "choice". */
const numbered: Readonly<Record<string, number>> = {
  one: 0, "1": 0, a: 0,
  two: 1, "2": 1, b: 1,
  three: 2, "3": 2, c: 2,
  four: 3, "4": 3, d: 3,
}

/** Words a place is said with, besides numbers and letters. */
const ordinals: ReadonlySet<string> = new Set(["first", "second", "third", "fourth", "last", "latter", "former"])

/** The options as he heard them offered last, by their place in the part: all of them, or the others once he turned down yapd's pick. */
const offeredLast = (part: Said) => part.among ?? part.options.map((_, index) => index)

/**
 * Whether he heard the options in an order a place counts by: read out, or
 * the others after a no. Named only in the question, like "Should I deploy
 * now or wait?" to Wait and Deploy now, they came in its order, not the
 * agent's, so "the first one" is the model's to tell, seeing both.
 */
const ordered = (part: Said) => part.read || part.among !== undefined

/**
 * Whether a place he says can only be a place: he heard the options in an
 * order a place counts by, and no option's name has a word a place is said
 * with, like "first" or "last", a number or a letter, as "Last write wins",
 * "4 workers" or "Option B" do, which he may have meant instead. An "a"
 * before another word only points. An option known by its number goes by
 * its name as the agent wrote it, since its number is its place.
 */
const placeable = (part: Said) =>
  ordered(part) &&
  !part.options.some(({ label, said, by }) =>
    (by === "label" ? [unmarked(label), said] : [unmarked(label)]).some((name) => {
      const words = kept(name).split(" ")
      return words.some(
        (word, index) =>
          (word !== "a" || index === words.length - 1) &&
          (ordinals.has(word) || /\d/.test(word) || units[word] !== undefined || tens[word] !== undefined || /^\p{L}$/u.test(word)),
      )
    }),
  )

/**
 * An option by its place among what he was offered last, when a place can
 * only be one: after a no to yapd's pick, "the first one" is the first of
 * the others. "The last one" only once he's heard them all, `inFull`, since
 * cut off before then, the last he heard may not be the last there is.
 */
const byPlace = (part: Said, said: string, inFull: boolean) => {
  const found = place.exec(said)
  if (found === null || !placeable(part)) return undefined
  const [, word, number, letter] = found
  const offered = offeredLast(part)
  const last = word === "last" || word === "latter"
  if (last && !inFull) return undefined
  const at = last ? offered.length - 1 : word !== undefined ? placed[word] : numbered[number ?? letter ?? ""]
  return at === undefined ? undefined : offered[at]
}

/**
 * Words that say no, however they're written: "not", "never", "without",
 * or "don't" as Whisper may write it, "dont". The "n't" of "don't" is one
 * too, and so is the "t" left of "don’t" once `gist` takes its curly
 * apostrophe for a space.
 */
const denying = /^(?:not|no|nope|nah|never|none|nor|neither|nothing|without|cannot|non|\w+n't|(?:do|does|did|ca|wo|is|are|was|were|should|would|could|have|has|had|must|need)nt|aint)$/

/**
 * Whether his words name this option, rather than only agree with what yapd
 * would pick: its whole name among them, as in "Blue, I think", or its
 * place, as in "the second, please", when a place can only be one. Never
 * with a no anywhere in them, like "don't merge now" to "Merge now" or "not
 * the first one", which only the question heard in full settles.
 */
export const mentions = (part: Said, index: number, heard: string) => {
  const choice = part.options[index]
  if (choice === undefined) return false
  const said = figures(gist(heard))
  const words = said.split(" ")
  if (words.some((word, at) => denying.test(word) || (word === "t" && /n$/.test(words[at - 1] ?? "")))) return false
  const named = [unmarked(choice.label), choice.said].some((name) => {
    const whole = figures(unled(kept(name)))
    return whole !== "" && ` ${said} `.includes(` ${whole} `)
  })
  // By its place among what he was offered last, said as one, like "the second" or "option two": never a bare number or letter, which
  // say other things too, nor "last", which may be the last he'd heard.
  const offered = offeredLast(part)
  const at = placeable(part) ? offered.indexOf(index) : -1
  if (at < 0) return named
  const places = [...Object.entries(placed).flatMap(([word, place]) => (place === at ? [word] : [])), ...["option", "number", "choice"].map((kind) => `${kind} ${at + 1}`)]
  return named || places.some((words) => ` ${said} `.includes(` ${words} `))
}

/** Going ahead, like "ship it", "go ahead" or "yes, proceed", which may as well name an option as take yapd's pick: the model tells. */
const ahead: ReadonlySet<string> = new Set([...agreed].filter((said) => !/\bboth\b/.test(said)))

/** Plain yeses, which say nothing of any option: the only agreeing words that take yapd's pick without the model. */
const yeses: ReadonlySet<string> = new Set(["yes", "yeah", "yep", "yup", "sure", "absolutely", "of course", "yes of course", "yes yes", "yeah yeah"])

/** Agreeing, besides a plain yes, which is as much a yes to what the question asks as to yapd's pick, like "OK" to "OK to merge now?". */
const assenting: ReadonlySet<string> = new Set(["sounds good", "ok", "okay", "fine", "that's fine", "agreed"])

/** Taking yapd's pick by pointing at it, which is never a yes to what the question asks. */
const taking: ReadonlySet<string> = new Set([
  "your pick", "go with your pick", "the recommended one", "recommended", "what you recommend",
  "go with what you recommend", "whatever you recommend", "the one you recommend", "your recommendation", "go with your recommendation",
])

/** Plain noes. */
const noes: ReadonlySet<string> = new Set(["no", "nope", "nah", "no thanks", "no thank you", "don't", "do not", "no don't"])

/** Leaving the choice to yapd. */
const deciding: ReadonlySet<string> = new Set([
  "you decide", "your call", "up to you", "it's up to you", "whatever you think", "no preference", "either", "either one",
  "either is fine", "either's fine", "whichever", "whichever you like", "whichever you think", "don't mind", "i don't mind",
  "you choose", "you pick", "your choice",
])

/** None of the options, which the agent should hear. */
const nones: ReadonlySet<string> = new Set(["none", "neither", "none of those", "neither of those", "neither of them", "none of them", "neither one", "none of the above"])

/** Hearing it again. */
const repeating: ReadonlySet<string> = new Set([
  "say again", "say that again", "say it again", "repeat", "repeat that", "repeat it", "repeat the question", "what", "pardon", "come again",
  "sorry what", "what was that", "can you repeat that", "could you repeat that", "what's the question", "what was the question",
  "what did it ask", "read me the question", "ask me the question", "say the question again",
])

/** What the options mean. */
const explaining: ReadonlySet<string> = new Set([
  "what are the options", "what are my options", "what are the choices", "what options", "which options", "tell me more", "explain",
  "explain them", "explain that", "what's the difference", "what is the difference", "what do they mean", "what does that mean",
  "what do those mean", "tell me about them", "what are they",
])

/** Putting it off. */
const later: ReadonlySet<string> = new Set([
  "later", "not now", "ask me later", "ask me again later", "give me a minute", "give me a sec", "give me a second", "hold on", "hang on",
  "in a minute", "come back to it later", "come back to that later", "remind me later", "maybe later",
])

/** Going on to the next part. */
const skipping: ReadonlySet<string> = new Set(["skip", "skip it", "skip that", "skip that one", "skip this one", "next", "next one", "next question", "pass", "move on"])

/** Letting it go. */
const leaving: ReadonlySet<string> = new Set([
  ...enough, "never mind", "nevermind", "forget it", "forget about it", "leave it", "cancel", "stop asking", "drop it",
])

/** A question that asks which, how or what, rather than whether, like "Which colour?" or "What now?": never "What about the cache?". */
const asksWhich = /^(?:which|what(?! about)|what's|how(?! about)|where|when|who|whom|whose|why)\b/i

/**
 * Whether a plain yes or no answers the part's question itself, by the last
 * sentence that asks, whatever follows it, like "It locks the table for an
 * hour.", however it's put: "Should I keep the cache?", "Is caching still
 * needed?", "Ready to merge?" or "Keep the old config?". Never one that asks
 * which, nor one that names two things, like "Red or Blue".
 */
const whether = (part: Said) => {
  const last = (part.question.split(/(?<=[.!?:])\s+/).findLast((sentence) => sentence.endsWith("?")) ?? "").replace(/^(?:so|and|then|now|also)\b,?\s*/i, "")
  return last.endsWith("?") && !/\bor\b/i.test(last) && !asksWhich.test(last)
}

/**
 * Whether it answers how it's asked rather than which option, which then only
 * an option's name in full picks. Taking back what he just said, like "cancel
 * that" to "Cancel the deploy", may only drop the question: the model tells.
 */
const steers = (said: string) =>
  Brain.takesBack(said) || [ahead, yeses, assenting, taking, noes, deciding, nones, repeating, explaining, later, skipping, leaving].some((phrases) => phrases.has(said))

/** Words to stop yapd talking, put it off, skip it or hear it again: an option named so, like "Stop" or "Later", is only that once he's heard it offered. */
const hushing = (said: string) => [repeating, later, skipping, leaving].some((phrases) => phrases.has(said))

/**
 * The options a list names, each piece of it the whole name of one, as
 * `wholly` has it: "Alpha and Gamma", "Gamma plus Alpha". Undefined unless
 * every piece is, so "lint and docs" never names Skip docs, nor "just Beta"
 * Beta, nor "the first and the second" any place, nor "and lint", with
 * what came before it lost, Lint.
 */
const listed = (part: Said, heard: string): ReadonlyArray<number> | undefined => {
  const pieces = heard.replace(/([,;])\s*(?:and|plus)\b/gi, "$1").split(/[,;&+]|\b(?:and|plus)\b/i)
  if (pieces.some((piece) => gist(piece) === "")) return undefined
  const found = pieces.map((piece) => whole(part, piece))
  return found.every((index) => index !== undefined) ? [...new Set(found)].toSorted((a, b) => a - b) : undefined
}

/** All of them, both of two, or all but some: "all", "everything", "both", "all but Beta", of what he was offered last. */
const wholes = (part: Said, said: string): ReadonlyArray<number> | undefined => {
  const every = offeredLast(part)
  if (["all", "all of them", "everything", "every one", "all of those"].includes(said)) return every
  if (["both", "both of them"].includes(said) && every.length === 2) return every
  const but = /^(?:all|everything)(?: of them)? (?:but|except|except for|apart from|other than|bar) (.+)$/.exec(said)
  const left = but === null ? undefined : listed(part, but[1] ?? "")
  const kept = left === undefined ? [] : every.filter((index) => !left.includes(index))
  return kept.length > 0 ? kept : undefined
}

/**
 * What he said to a part comes to, without the model, only when that's
 * plain: an option's whole name, as `wholly` has it; its place, when he
 * heard them in order and no name has a word a place is said with; for a
 * part that takes several, every option, all but some, or a list of whole
 * names; a plain yes or no to the option named Yes or No, or "Yes, …" or
 * "No, …"; yapd's pick, on a plain yes once he's heard it in full, unless
 * the question asks whether or an option starts with a yes or a no, or on
 * "your pick"; his own words for "you decide" or "none of those"; or what
 * he wants done with the question itself.
 * `inFull` is whether he heard the part through to yapd's pick, and
 * `parts` how many it has. Undefined for anything else, which is the
 * model's to judge: part of a name, a word of it, words in another order,
 * a no or "just" or "instead" with a name. Words like "stop", "skip" or
 * "later" are never taken for an option named just so before he's heard
 * it in full, and words that let it go but start an option, like "leave
 * it" to "Leave the changelog", are the model's too once he has, while
 * "skip it" or "next" to a part with more after it and "Skip the slow
 * tests" or "Next release" asks which of them.
 */
export const pick = (part: Said, heard: string, asked: { readonly inFull: boolean; readonly parts: number }): Reply | undefined => {
  const said = gist(heard)
  if (said === "") return undefined
  const picked = (options: ReadonlyArray<number>): Reply => ({ _tag: "Picked", options })
  // "Stop" or "Later" said before he'd heard the options can't be to one he didn't know of, called that: it's to stop yapd, or put it off.
  const unheard = !asked.inFull && hushing(said)
  const named = unheard ? [] : wholly(part, heard)
  // Named alike, like "c" for "C++" and "C#", which he meant is the model's to tell: never a letter's place either.
  if (named.length > 0) return named.length === 1 ? picked(named) : undefined
  // A form that takes only its options asks which of them instead.
  const words = (text: string): Reply => (part.ownWords ? { _tag: "Words", text } : { _tag: "Which" })
  if (!steers(said)) {
    const placed = byPlace(part, said, asked.inFull)
    if (placed !== undefined) return picked([placed])
    const several = part.several ? (wholes(part, said) ?? listed(part, heard)) : undefined
    return several === undefined ? undefined : picked(several)
  }
  const recommended = Option.getOrUndefined(part.recommended)
  const yes = yeses.has(said)
  const no = noes.has(said)
  // A plain yes or no is to the option that is one, named just so or with a comma after it, like "No, skip tests", whatever yapd would pick.
  const answer = yes || no ? one(fitting(part, ({ said: name }) => (yes ? /^yes(?:,|$)/i : /^no(?:,|$)/i).test(name))) : undefined
  if (answer !== undefined) return picked([answer])
  // Otherwise, to options, it may be to what the question asks, or to one that starts like it, like "No cache" or "Sure, after the
  // release", rather than to yapd's pick: the model tells, seeing both.
  const starting = part.options.some(({ said: name }) => /^(?:yes|no)\b/i.test(name) || `${kept(name)} `.startsWith(`${said} `))
  if ((yes || no) && part.options.length > 0 && (starting || whether(part))) return undefined
  // A plain yes, or what only points at yapd's pick, takes it once he's heard it in full; before then, he's to hear it in full.
  if ((yes || taking.has(said)) && recommended !== undefined) return asked.inFull ? picked([recommended]) : { _tag: "Again" }
  if (deciding.has(said)) return recommended !== undefined ? picked([recommended]) : words("You decide.")
  if (nones.has(said)) return words("None of those.")
  if (no && recommended !== undefined) return asked.inFull ? { _tag: "Instead" } : undefined
  if (part.options.length === 0 && yes) return words("Yes")
  if (part.options.length === 0 && no) return words("No")
  if (repeating.has(said)) return { _tag: "Again" }
  if (explaining.has(said)) return { _tag: "More" }
  if (later.has(said)) return { _tag: "Later" }
  // "Leave it" to "Leave the changelog", "cancel" to "Cancel the deploy", or "next one" to "Next release", may well be that option, which
  // the model tells. Never words to stop talking, like "skip it", "next" or "stop", which no agent gets, nor "never mind" or "forget it",
  // nor any said before he'd heard the options, which can't be to one he didn't know of, as with "Stop" above.
  const lead = /^(?:leave|cancel|drop|skip|pass|move|next)\b/.exec(said)?.[0]
  const leads = lead !== undefined && fitting(part, ({ said }) => new RegExp(`^${lead}\\b`, "i").test(said)).length > 0
  if ((leaving.has(said) || skipping.has(said)) && !enough.has(said) && leads && !unheard) return undefined
  // "Skip it" to "Skip the slow tests", with more parts after it, may be that option too, and leaving the part out would sound as if it
  // was taken: he's asked which of them instead, since words to stop talking never go to the model.
  if (skipping.has(said) && asked.parts > 1) return leads ? { _tag: "Which" } : { _tag: "Skip" }
  if (leaving.has(said) || skipping.has(said)) return { _tag: "Leave" }
  return undefined
}

/**
 * What the model's answer to a part comes to: the options, when every line
 * of it is one's whole name, as `wholly` has it, as yapd's own pick is, as
 * a list only for a part that takes several; otherwise his own words, as
 * he'd type them, or, for a form that takes only its options, which of them
 * instead. Nothing at all is to hear it again.
 */
export const resolve = (part: Said, text: string): Reply => {
  const trimmed = text.trim()
  if (trimmed === "") return { _tag: "Again" }
  const found = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => whole(part, line))
  const options = [...new Set(found.flatMap((index) => (index === undefined ? [] : [index])))].toSorted((a, b) => a - b)
  const every = found.length > 0 && !found.includes(undefined)
  if (every && (part.several || options.length === 1)) return { _tag: "Picked", options }
  return part.ownWords ? { _tag: "Words", text: trimmed } : { _tag: "Which" }
}

/**
 * What's sent for a question, from the answers collected for its parts, by
 * their ids: an option as it takes it, a list only for a part that takes
 * several and is answered straight to the agent, and his own words as they
 * are. A part he skipped is left out, which the agent reads as unanswered,
 * except that one answered as a message needs every part it needs.
 * "mismatched" when an answer is under an id or an option the question
 * doesn't have, which T3 Code would take without a word.
 */
export const answers = (
  request: Pick<Extract<T3Actions.Request, { readonly _tag: "Question" }>, "questions" | "mode">,
  collected: Readonly<Record<string, Answer>>,
): Either.Either<Readonly<Record<string, string | ReadonlyArray<string>>>, "mismatched" | "unanswered"> => {
  const ids = new Set(request.questions.map(({ id }) => id))
  if (Object.keys(collected).some((id) => !ids.has(id))) return Either.left("mismatched")
  const sent: Record<string, string | ReadonlyArray<string>> = {}
  for (const question of request.questions) {
    const answer = Object.hasOwn(collected, question.id) ? collected[question.id] : undefined
    if (answer === undefined || answer._tag === "Skip") {
      if (request.mode === "message" && question.required) return Either.left("unanswered")
      continue
    }
    if (answer._tag === "Words") {
      sent[question.id] = answer.text
      continue
    }
    const chosen = answer.options.map((index) => question.options[index])
    if (chosen.length === 0 || chosen.some((option) => option === undefined)) return Either.left("mismatched")
    const values = chosen.flatMap((option) => (option === undefined ? [] : [T3Actions.choice(option)]))
    sent[question.id] = question.multiSelect && request.mode === "live" ? values : values.join(", ")
  }
  return Either.right(sent)
}
