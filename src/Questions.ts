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
// yapd's own pick. His answer is matched to an option by its name, how it
// sounds, its place or a word only it has; anything else is his own words,
// which go to the agent as he said them, since it asked him, not a form.

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
   * place, a letter or "all" counts among these, as he heard them.
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

/** How it sounds, spaces and marks aside: "ghost net" is Ghostnet, "day js" is Day.js, "four workers" is 4 workers. */
const sound = (text: string) => figures(gist(text)).replace(/[^\p{L}\p{N}]+/gu, "")

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

/** The options a name fits, as written or as said, or failing that by how it sounds: more than one when they're named alike. */
const named = (part: Said, said: string) => {
  const found = fitting(part, ({ label, said: name }) => [label, unmarked(label), name].some((written) => gist(written) === said))
  if (found.length > 0 || sound(said) === "") return found
  return fitting(part, ({ label, said: name }) => [unmarked(label), name].some((written) => sound(written) === sound(said)))
}

/** An option by its name, as written or as said, or failing that by how it sounds, when only one fits. */
const byName = (part: Said, said: string) => one(named(part, said))

/** Whether what he said is one option's name in full, marks and all, as compared, or by how it sounds, like "Cancel the run". */
export const names = (part: Said, heard: string) => exactly(part, heard) !== undefined || byName(part, gist(heard)) !== undefined

/** Whether an option's name starts with these words, as written or as said, like "Cancel the deploy" with "cancel". */
export const opens = (part: Said, heard: string) => gist(heard) !== "" && opening(part, gist(heard)).length > 0

/**
 * Whether the options are named with numbers, like "2 workers" or "Node 20":
 * then a number he says is the one in a name, never a place.
 */
const numbered = (part: Said) => part.options.some(({ label, by }) => by === "label" && /\d/.test(figures(gist(unmarked(label)))))

/** An option by its place: "the second one", "number two", "option B", "last". */
const place = /^(the )?(?:(option|number|choice) )?(first|second|third|fourth|last|latter|former|1st|2nd|3rd|4th|one|two|three|four|[1-4]|[a-d])(?: one| option)?$/

const places: Readonly<Record<string, number>> = {
  first: 0, former: 0, "1st": 0, one: 0, "1": 0, a: 0,
  second: 1, "2nd": 1, two: 1, "2": 1, b: 1,
  third: 2, "3rd": 2, three: 2, "3": 2, c: 2,
  fourth: 3, "4th": 3, four: 3, "4": 3, d: 3,
}

/** The words the options' names have, as written and as compared, but "a" before another word, which only points. */
const ownWords = (part: Said) =>
  new Set(
    part.options.flatMap(({ label, said }) =>
      [unmarked(label), said].flatMap((name) => {
        const kept = gist(name)
          .split(" ")
          .filter((word, index, all) => word !== "a" || index === all.length - 1)
          .join(" ")
        return [...kept.split(" "), ...figures(kept).split(" ")]
      }),
    ),
  )

/** The options as he heard them offered last, by their place in the part: all of them, or the others once he turned down yapd's pick. */
const offeredLast = (part: Said) => part.among ?? part.options.map((_, index) => index)

/**
 * Whether he heard the options in an order a place counts by: read out, or
 * the others after a no. Named only in the question, like "Should I deploy
 * now or wait?" to Wait and Deploy now, they came in its order, not the
 * agent's, so "the first one" is the model's to tell, seeing both.
 */
const ordered = (part: Said) => part.read || part.among !== undefined

/** A place said as one, by its order, like "the first one" or "last one", rather than "first" on its own, which may be a name's word. */
const ordinally = (said: string) => /^(?:the (?:first|second|third|fourth|last|latter|former|1st|2nd|3rd|4th)(?: one| option)?|(?:first|second|third|fourth|last|1st|2nd|3rd|4th) one)$/.test(said)

const byPlace = (part: Said, said: string) => {
  const found = place.exec(said)
  if (found === null || !ordered(part)) return undefined
  const [, the, kind, which = ""] = found
  // A letter on its own only when no option goes by one, and "the one" is no place at all.
  if (kind === undefined && /^[a-d]$/.test(which) && part.options.some(({ said }) => /^\p{L}$/u.test(said.trim()))) return undefined
  if (kind === undefined && the !== undefined && which === "one") return undefined
  // A letter, a number or a word like "first" that an option's name has is that name's, never a place, as "A" to "Option B" and "Option A",
  // or "first" to "First write wins": the name decides, or the model does. Only "option four" to options that count, like 4 workers, is.
  const counting = (kind === "option" || kind === "choice") && /^(?:one|two|three|four|[1-4])$/.test(which) && !part.opaque
  const own = ownWords(part)
  if (!counting && (own.has(which) || own.has(figures(which)))) return undefined
  // "Four" to 2, 4, 8 or 16 workers is 4 workers, not the fourth: only "the fourth" or "option four" is a place then.
  if (kind !== "option" && kind !== "choice" && /^(?:one|two|three|four|[1-4])$/.test(which) && numbered(part)) return undefined
  // Counted among what he was offered last: after a no to yapd's pick, "the first one" is the first of the others.
  const offered = offeredLast(part)
  const at = which === "last" || which === "latter" ? offered.length - 1 : places[which]
  return at === undefined ? undefined : offered[at]
}

/** Words in an answer that only point, around the ones that name. */
const pointing: ReadonlySet<string> = new Set([
  "the", "one", "ones", "that", "this", "with", "about", "on", "option", "choice", "go", "use", "pick", "take", "let's", "i'll", "i'd",
  "we'll", "want", "choose", "a", "an", "just", "only",
])

/** The options whose names have every word he named them with: "the blue one", "full history", "the four one" for 4 workers. */
const having = (part: Said, said: string) => {
  const named = figures(said)
    .split(" ")
    .filter((word) => !pointing.has(word))
  if (named.length === 0) return []
  return fitting(part, (choice) => {
    const own = new Set([unmarked(choice.label), choice.said].flatMap((name) => figures(gist(name)).split(" ")))
    return named.every((word) => own.has(word))
  })
}

/** An option by the words he named it with, all of them its own and no other's. */
const byWords = (part: Said, said: string) => one(having(part, said))

/** The options whose names start with these words, as written or as said: "ship it" starts "Ship it now". */
const opening = (part: Said, said: string) => {
  const words = `${figures(said)} `
  return fitting(part, ({ label, said: name }) => [unmarked(label), name].some((written) => `${figures(gist(written))} `.startsWith(words)))
}

/** A yes at the start of words that agree, like "yes" in "yes, ship it" or "sounds good" in "sounds good, go ahead". */
const yesFirst = /^(?:(?:yes|yeah|yep|yup|sure|ok|okay|sounds good) )+/

/** Words an option's name has that say nothing of which it is. */
const glue: ReadonlySet<string> = new Set(["and", "or", "of", "to", "for", "in", "it", "is", "with", "as"])

/** Words in an answer that only agree, saying nothing of which option: "yes", "sure", "sounds good", "your pick". */
const nodding: ReadonlySet<string> = new Set([
  "yes", "yeah", "yep", "yup", "sure", "absolutely", "course", "ok", "okay", "sounds", "good", "fine", "that's", "it's", "agreed", "your",
  "what", "whatever", "you", "recommend", "recommended", "recommendation",
])

/** A pick that holds back, like "Pause", "Wait for CI" or "Not yet", but never "Keep going", which goes on. */
const holding = /^(?:pause|wait|hold|not|no|don['’]t|stop|keep(?! going| on\b| running)|skip|leave|cancel|abort|postpone|defer|later)\b/i

/** Words to go ahead, like "proceed", "go on" or "yes, ship it". */
const going = /\b(?:proceed|go on|go ahead|do it|go for it|carry on|continue|ship it|merge it)\b/

/**
 * Whether words that agree may be to another option than yapd's pick: they,
 * or the word they start with, start its name, or its name has them all,
 * like "ship it" to "Ship it now", "okay, do it" to "OK, but only on
 * staging", or "fine" to "Fine as it is"; and so with what follows a yes,
 * like "yes, ship it" to "Ship it now" or "sure, go ahead" to "Go ahead
 * with the rename"; or its name has any word of his that says more than
 * yes, wherever it is in it, like "merge" in "yes, merge it" to "Squash and
 * merge"; or they go ahead, to a pick that holds back, like "proceed" to
 * Pause and "Continue the migration".
 */
const elsewhere = (part: Said, said: string, pick: number | undefined) => {
  const [first = ""] = said.split(" ")
  const starts = first === said || pointing.has(first) ? [said] : [said, first]
  const rest = said.replace(yesFirst, "")
  const after = rest === said || rest === "" ? [] : [rest]
  const opens = [...starts, ...after].flatMap((words) => opening(part, words))
  const has = [said, ...after].flatMap((words) => having(part, words))
  const own = figures(said)
    .split(" ")
    .filter((word) => !pointing.has(word) && !glue.has(word) && !nodding.has(word))
  const shares = fitting(part, ({ label, said: name }) => [unmarked(label), name].some((written) => figures(gist(written)).split(" ").some((word) => own.includes(word))))
  const ahead = going.test(said) && holding.test(part.options[pick ?? -1]?.said ?? "")
  return ahead || [...opens, ...has, ...shares].some((index) => index !== pick)
}

/**
 * Whether his words name this option, by a word of its name or by its
 * place, rather than only agree with what yapd would pick: "Blue, I think"
 * and "the second, please" do, "yeah, that works" doesn't.
 */
export const mentions = (part: Said, index: number, heard: string) => {
  const choice = part.options[index]
  if (choice === undefined) return false
  const words = new Set(figures(gist(heard)).split(" "))
  const own = [unmarked(choice.label), choice.said].flatMap((name) => figures(gist(name)).split(" ")).filter((word) => word !== "" && !pointing.has(word) && !glue.has(word))
  // Not by a letter, nor "one", which say other things too; and by its place among what he was offered last, when he heard them in order.
  const offered = offeredLast(part)
  const place = ordered(part) ? offered.indexOf(index) : -1
  const placed = Object.entries(places).flatMap(([word, at]) => (place >= 0 && at === place && !/^(?:[a-d]|one)$/.test(word) ? [word] : []))
  const last = place >= 0 && place === offered.length - 1 ? ["last", "latter"] : []
  return [...own, ...placed, ...last].some((word) => words.has(word))
}

/** Plain yeses. */
const yeses: ReadonlySet<string> = new Set([...agreed].filter((said) => !/\bboth\b/.test(said)))

/** Agreeing, besides a plain yes, which is as much a yes to what the question asks as to yapd's pick, like "OK" to "OK to merge now?". */
const assenting: ReadonlySet<string> = new Set(["sounds good", "ok", "okay", "fine", "that's fine", "agreed"])

/** Taking yapd's pick by pointing at it, which is never a yes to what the question asks. */
const taking: ReadonlySet<string> = new Set([
  "go with that", "go with it", "that one", "your pick", "go with your pick", "the recommended one", "recommended", "what you recommend",
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
  Brain.takesBack(said) || [yeses, assenting, taking, noes, deciding, nones, repeating, explaining, later, skipping, leaving].some((phrases) => phrases.has(said))

/** Words to stop yapd talking, put it off, skip it or hear it again: an option named so, like "Stop" or "Later", is only that once he's heard it offered. */
const hushing = (said: string) => [repeating, later, skipping, leaving].some((phrases) => phrases.has(said))

/**
 * The one option words mean, by its name or its sound, or, unless they're
 * about how it's asked, by its place or words only it has. Never when they
 * name several alike, like "c" for "C++" and "C#": that's no letter's place
 * either, and which he meant is the model's to tell.
 */
const meant = (part: Said, said: string) => {
  const names = named(part, said)
  if (names.length > 1) return undefined
  if (names[0] !== undefined) return names[0]
  if (steers(said)) return undefined
  // "The last one" to "Last write wins", listed first, may be either, which the model tells: only a bare "last" is that name's.
  return byPlace(part, said) ?? (ordinally(said) ? undefined : byWords(part, said))
}

/**
 * The options a list names, each by its name, place or words: "Alpha and
 * Gamma", "A, B plus C", "just A". Undefined unless every piece names one.
 */
const listed = (part: Said, heard: string): ReadonlyArray<number> | undefined => {
  const pieces = heard
    .split(/[,;&+]|\b(?:and|plus)\b/i)
    .map((piece) => gist(piece).replace(/^(?:and|just|only|also) /, ""))
    .filter((piece) => piece !== "" && piece !== "and")
  if (pieces.length === 0) return undefined
  const found = pieces.flatMap((piece) => {
    const single = meant(part, piece)
    // "Alpha Gamma", with what came between them lost, is each by its name.
    return single !== undefined ? [single] : piece.split(" ").map((word) => byName(part, word))
  })
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
 * What he said to a part comes to, without the model, when that's plain:
 * an option by its name, marks and all, then as compared, how it sounds,
 * its place, or words only it has, though never by a name several share;
 * several, for a part that takes several; yapd's pick, on a yes once he's
 * heard it in full, unless the yes may be to another, like "ship it" to
 * "Ship it now", or to the question, as when the pick is a no; the option
 * that starts with yes or no, on a plain yes or no, which is otherwise the
 * model's when the question asks whether; his own words for "you decide"
 * or "none of those"; or what he wants done with the question itself.
 * `inFull` is whether he heard the part through to yapd's pick, and
 * `parts` how many it has. Undefined for anything else, which is the
 * model's to judge. Words like "stop", "skip" or "later" are never taken
 * for an option they're only a word of, nor for one named just so before
 * he's heard it in full, and words that let it go but
 * start an option, like "leave it" to "Leave the changelog", are the
 * model's too once he has, while "skip it" or "next" to a part with more
 * after it and "Skip the slow tests" or "Next release" asks which of them.
 */
export const pick = (part: Said, heard: string, asked: { readonly inFull: boolean; readonly parts: number }): Reply | undefined => {
  const said = gist(heard)
  if (said === "") return undefined
  const picked = (options: ReadonlyArray<number>): Reply => ({ _tag: "Picked", options })
  // "Stop" or "Later" said before he'd heard the options can't be to one he didn't know of, called that: it's to stop yapd, or put it off.
  const unheard = !asked.inFull && hushing(said)
  const exact = unheard ? undefined : exactly(part, heard)
  if (exact !== undefined) return picked([exact])
  // A form that takes only its options asks which of them instead.
  const words = (text: string): Reply => (part.ownWords ? { _tag: "Words", text } : { _tag: "Which" })
  if (!steers(said)) {
    const single = meant(part, said)
    if (single !== undefined) return picked([single])
    const several = part.several ? (wholes(part, said) ?? listed(part, heard)) : undefined
    return several === undefined ? undefined : picked(several)
  }
  const named = unheard ? undefined : byName(part, said)
  if (named !== undefined) return picked([named])
  const starting = (word: string) => one(fitting(part, ({ said }) => new RegExp(`^${word}\\b`, "i").test(said)))
  const recommended = Option.getOrUndefined(part.recommended)
  // A plain yes or no is to the option that is one, whatever yapd would pick.
  const yes = yeses.has(said) ? starting("yes") : undefined
  if (yes !== undefined) return picked([yes])
  const no = noes.has(said) ? starting("no") : undefined
  if (no !== undefined) return picked([no])
  const assents = yeses.has(said) || assenting.has(said)
  const agreeing = assents || taking.has(said)
  // "Ship it" to "Ship it now", heard in full or not, may well be that option rather than a yes to yapd's pick: which is the model's to tell.
  if (agreeing && elsewhere(part, said, recommended)) return undefined
  // A plain yes or an okay may be to the question, not to yapd's pick, when that's a no, like "No, skip tests" to "Should I add tests?",
  // and so may a plain no to one a yes or no answers, like "OK to merge now?", with no option that's either: the model tells, seeing both.
  const pickedNo = recommended !== undefined && /^no\b/i.test(part.options[recommended]?.said ?? "")
  const neither = part.options.length > 0 && fitting(part, ({ said }) => /^(?:yes|no)\b/i.test(said)).length === 0
  if ((assents && pickedNo) || ((assents || noes.has(said)) && neither && whether(part))) return undefined
  if (agreeing && recommended !== undefined) return asked.inFull ? picked([recommended]) : { _tag: "Again" }
  if (deciding.has(said)) return recommended !== undefined ? picked([recommended]) : words("You decide.")
  if (nones.has(said)) return words("None of those.")
  if (noes.has(said) && recommended !== undefined) return asked.inFull ? { _tag: "Instead" } : undefined
  if (part.options.length === 0 && yeses.has(said)) return words("Yes")
  if (part.options.length === 0 && noes.has(said)) return words("No")
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
 * of it names one, by its name as written first, as yapd's own pick is, as
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
    .flatMap((line): ReadonlyArray<number | undefined> => {
      const exact = exactly(part, line)
      if (exact !== undefined) return [exact]
      const said = gist(line)
      const single = meant(part, said)
      if (single !== undefined || !part.several) return [single]
      return wholes(part, said) ?? listed(part, line) ?? [undefined]
    })
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
