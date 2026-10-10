import { Clock, type Duration, Effect, Fiber, Option, Queue, Scope, Stream } from "effect"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { Audio, AudioError, type Playback } from "./Audio.ts"
import type { Turn } from "./Condenser.ts"
import * as Endpointer from "./Endpointer.ts"
import { plain, RelayError, type Thread } from "./Relay.ts"
import { Journal } from "./Journal.ts"
import { Persona } from "./Persona.ts"
import { gist, hallucinated, type Line, type Reply, Responder } from "./Responder.ts"
import type * as Threads from "./Threads.ts"
import { Transcriber } from "./Transcriber.ts"
import { Vad } from "./Vad.ts"
import { extension, Voice } from "./Voice.ts"

/** An update, rendered and ready to be read out. */
export interface Update {
  readonly session: string
  readonly project: string
  readonly turn: Turn
  /** Whether the agent asked something, needs a decision or permission, or failed. */
  readonly needsYou: boolean
  readonly spoken: string
  readonly audio: string
  readonly thread: Thread
  /** When its turn stopped. */
  readonly at: number
  /** The T3 Code thread it came from, when its hook could be tied to one, or T3 Code told of it. */
  readonly about?: Threads.Ref
}

type Signal =
  | Exclude<Endpointer.Event, { readonly _tag: "Onset" }>
  /**
   * Might be the user, or with `echo`, yapd's own voice getting into the
   * microphone, as it can until the echo cancellation has learnt it.
   */
  | { readonly _tag: "Onset"; readonly echo: boolean }
  /** The microphone stopped, like when the helper quits. */
  | { readonly _tag: "Deaf" }
  /** The rest carry the id of what sent them, so one that's no longer waited on is let go. */
  | { readonly _tag: "Finished"; readonly id: number }
  /** The playback broke off, like when the audio helper quits: what it played wasn't heard to the end. */
  | { readonly _tag: "Broke"; readonly id: number; readonly error: AudioError }
  | { readonly _tag: "Lingered"; readonly id: number }
  /** The reply is whatever the one who asked for it works out: what to do about an update, or an answer to a question. */
  | { readonly _tag: "Replied"; readonly id: number; readonly reply: unknown }

/**
 * The microphone for a whole update, so nothing the user says is missed
 * between lines, like while yapd works out what to say back.
 */
interface Ear {
  readonly signals: Queue.Queue<Signal>
  deaf: boolean
}

/** How a line went: played out, or talked over, with what the user said. */
type Outcome =
  | { readonly _tag: "Finished" }
  | {
      readonly _tag: "Interrupted"
      /** How far it got, in seconds. */
      readonly at: number
      readonly duration: number
      readonly audio: Float32Array
      readonly ear: Ear
      /**
       * What yapd was saying around when he began, when that was while its
       * own voice could still get into the microphone: what was heard may be
       * some of that, or his first word lost under it.
       */
      readonly echo?: string
      /** How far into the line he began, then. */
      readonly onset?: number
    }

/** How long the microphone stays open after yapd stops, for a reply to what it just said. */
const linger: Duration.DurationInput = "3 seconds"
/** Longer after a question, which takes a moment's thought to answer. */
const pondering: Duration.DurationInput = "8 seconds"
/** Longer than the longest utterance, so only a microphone that went quiet trips it. */
const patience = "40 seconds"
/** Volume while it's still unclear whether the user is talking. */
const ducked = 0.25
/** How far back to pick up after talk that wasn't meant for yapd. */
const rewind = 1.5
/** How far back to pick up after only its own voice stopped it, or what may have been: just before, so the same opening isn't heard again and again. */
const before = 0.3
/**
 * How long speech can go on past where yapd stopped and still be only its
 * own voice dying away, in the room and in the voice detector: more than
 * that, someone else was talking.
 */
const overhang = 0.25
/** How near its end a line can be stopped and still count as said, with nothing of it left to go back to. */
const ending = 0.3
/** Talk that wasn't meant for yapd, after which the rest of an update plays without listening, say for a TV. */
const misses = 3
/** How long to wait for the rest when the user trails off, before working out a reply. */
const hesitation = "3 seconds"
/** How long the user can keep adding to what they said, since talk that goes on longer is more likely a TV. */
const rambling = 60_000

/** Words a sentence hardly ever ends on. */
const dangling = /\b(and|or|but|to|the|a|an|of|for|with|my|your|if|when|because)[.,]?$/i

/** Whether the user seems to have stopped mid-thought: Whisper marks trailing off with an ellipsis. */
export const unfinished = (heard: string) => /(\.\.\.|…|,)$/.test(heard) || dangling.test(heard)

/** What the user said before and after a pause, as one. */
export const together = (before: string, after: string) =>
  after === "" ? before : `${before.replace(/\s*(\.\.\.|…)$/, "")} ${after}`

/** What's said of a reply held back because the work it answers has been given something else since. */
export const movedOn = "You've moved on from that since, so I held it back."

/** Seconds of speech in what the user said, less the quiet the endpointer keeps either side of it. */
export const voiced = (audio: Float32Array) =>
  Math.max(0, (audio.length - (Endpointer.defaults.lead + Endpointer.defaults.tail) * frame) / rate)

/** Samples a second from the microphone, and in each frame of it. */
const rate = 16000
const frame = 512

/** The part of `text` heard in `fraction` of its audio, marked when it's cut short. */
export const cut = (text: string, fraction: number) => {
  if (fraction >= 1) return text
  const words = text.split(/\s+/)
  return `${words.slice(0, Math.max(1, Math.round(words.length * fraction))).join(" ")}…`
}

/** Seconds either side of the user talking that yapd's words are looked for in what he said, since where each falls in a line is only guessed. */
const reach = 4

/** Words only what Whisper makes up has, from the videos it learnt on, which give away the whole sentence they're in. */
const giveaways: ReadonlySet<string> = new Set(["subscribe", "subscribed", "amara", "applause", "laughter", "verse", "chorus"])

/** Words what Whisper makes up has, from the videos it learnt on, but that he may say too, like "Pause the video.": they give a sentence away only when it has nothing else of his. */
const tells: ReadonlySet<string> = new Set(["watching", "video", "videos", "channel", "music", "song", "subtitles", "captions", "transcription"])

/** Words Whisper makes up on their own, or that only fill a pause, so they say nothing of who said them. Not "yes", which answers yapd. */
const fillers: ReadonlySet<string> = new Set([
  "you", "thank", "thanks", "bye", "okay", "ok", "so", "mm", "mhm", "huh", "hello", "hi", "hey", "wow", "right", "alright", "kid",
])

/** Words in nearly anything either says, so yapd saying them too is no sign it's its own voice, nor Whisper hearing them a sign it's his. */
const common: ReadonlySet<string> = new Set([
  "a", "an", "the", "it", "it's", "its", "is", "are", "was", "were", "be", "been", "am", "do", "did", "does", "don't", "to", "on", "in",
  "of", "for", "at", "by", "with", "from", "as", "and", "or", "but", "if", "not", "now", "then", "that", "that's", "this", "there",
  "here", "what", "what's", "which", "who", "how", "why", "when", "where", "i", "i'm", "i'll", "i've", "me", "my", "we", "us", "our",
  "your", "he", "she", "they", "them", "can", "could", "would", "should", "will", "just", "up", "out", "off", "over", "all", "any",
  "some", "about", "into", "than", "too", "also", "go", "let", "let's", "get", "got", "one", "have", "has", "had", "going", "gonna",
  "know", "see", "come", "like", "want", "think", "say", "said", "make", "take", "look", "good", "well", "very", "much", "more",
  "really", "way", "there's", "you're", "we're", "didn't", "doesn't", "isn't", "can't", "won't",
])

/** Words that turn what's said around, so one is never taken for a word of yapd's it isn't, like "not" for "now". */
const negations: ReadonlySet<string> = new Set([
  "no", "not", "don't", "didn't", "doesn't", "isn't", "aren't", "wasn't", "weren't", "can't", "cannot", "won't", "wouldn't", "shouldn't",
  "couldn't", "haven't", "hasn't", "hadn't", "never", "nothing", "none", "neither", "nor",
])

/** The words of `text` said between `start` and `end` seconds into its `duration`, as far as that can be told from where they fall in it. */
export const between = (text: string, duration: number, start: number, end: number) => {
  if (duration <= 0) return text
  const words = text.split(/\s+/).filter((word) => word !== "")
  return words.slice(Math.max(0, Math.floor((words.length * start) / duration)), Math.max(0, Math.ceil((words.length * end) / duration))).join(" ")
}

/** A word as it's matched, so "tests" is "test" and "it's" is "it", but "is" is still "is". */
const stem = (word: string) => {
  const stemmed = word.replace(/'s$/, "")
  return stemmed.length > 3 ? stemmed.replace(/s$/, "") : stemmed
}

/** How many letters one word is from the other: put in, taken out or changed. */
const apart = (one: string, other: string) => {
  let above = Array.from({ length: other.length + 1 }, (_, index) => index)
  for (let row = 1; row <= one.length; row++) {
    const here = [row]
    for (let column = 1; column <= other.length; column++) {
      here[column] = Math.min(above[column]! + 1, here[column - 1]! + 1, above[column - 1]! + (one[row - 1] === other[column - 1] ? 0 : 1))
    }
    above = here
  }
  return above[other.length]!
}

/** Voiced consonants as their unvoiced likes, which Whisper swaps hearing a name it doesn't know. */
const unvoiced: Readonly<Record<string, string>> = { b: "p", d: "t", g: "k", v: "f", z: "s" }

/** A word by its sound, near enough: its first letter, then its consonants, unvoiced, each once in a row, so "yapped" and "yapti" sound like "yapd". */
const sound = (word: string) =>
  word.charAt(0) +
  word
    .slice(1)
    .replace(/[aeiouyhw']/g, "")
    .replace(/[bdgvz]/g, (letter) => unvoiced[letter]!)
    .replace(/(.)\1+/g, "$1")

/**
 * Whether Whisper may have heard a word yapd said as `heard`: a letter or so
 * apart, like "codecs" for "Codex" or "yap" for "yapd", the start of it, like
 * "stop" for "stopped" cut off partway, or a word that sounds like it, as
 * Whisper writes a name it doesn't know, like "yapped" for "yapd", but never
 * "on" for "in", "not" for "now", or a word nearly anything has for another,
 * like "was" for "pass" or "them" for "the migration", which would make a
 * word of his look like its.
 */
const alike = (heard: string, spoken: string) => {
  if (heard !== spoken && (negations.has(heard) || negations.has(spoken))) return false
  const [first, second] = [stem(heard), stem(spoken)]
  const shorter = Math.min(first.length, second.length)
  if (first === second) return true
  if (common.has(heard)) return false
  if (first.length >= 4 && second.startsWith(first)) return true
  if (shorter < 3) return false
  const distance = apart(first, second)
  if (distance <= (shorter >= 6 ? 2 : 1)) return true
  return shorter >= 4 && distance * 2 <= Math.max(first.length, second.length) && sound(first).length >= 3 && sound(first) === sound(second)
}

/** Letters as they sound, loosely, for telling a name: "c", "q" and "g" as "k", "j" as "y", and the voiced as the unvoiced. */
const loose: Readonly<Record<string, string>> = { ...unvoiced, c: "k", q: "k", j: "y" }

/** A word's consonants, as they sound, loosely, each once in a row, after its first letter, any vowel as "a": "Japan" is "ypn", like "yapd"'s "ypt". */
const skeleton = (word: string) => {
  const spelt = stem(word).replace(/ck/g, "k").replace(/ph/g, "f").replace(/x/g, "ks").replace(/'/g, "")
  return `${spelt.charAt(0).replace(/[aeiou]/, "a")}${spelt.slice(1).replace(/[aeiouyhw]/g, "")}`
    .replace(/[bdgvzcqj]/g, (letter) => loose[letter]!)
    .replace(/(.)\1+/g, "$1")
}

/** How many letters the two have in common, in order. */
const shared = (one: string, other: string) => {
  let above = Array.from({ length: other.length + 1 }, () => 0)
  for (const letter of one) {
    const here = [0]
    for (let column = 1; column <= other.length; column++) {
      here[column] = letter === other[column - 1] ? above[column - 1]! + 1 : Math.max(above[column]!, here[column - 1]!)
    }
    above = here
  }
  return above[other.length]!
}

/**
 * Whether `heard`, one word or a few run together, may be how Whisper wrote a
 * name of yapd's it doesn't know: like it, or starting the same, with all but
 * one of its consonants, like "Japan" or "your app" for "yapd", "Rick" for
 * "rig", but never "fix" for "green".
 */
const near = (heard: string, spoken: string) => {
  if (alike(heard, spoken)) return true
  if (common.has(heard) || negations.has(heard)) return false
  const [one, other] = [skeleton(heard), skeleton(spoken)]
  const same = shared(one, other)
  return one.charAt(0) === other.charAt(0) && same >= 2 && same >= Math.max(one.length, other.length) - 1
}

/** Words as they're matched: with names, which Whisper hears wrong more than anything, but not the "sir" or the "um" around them. */
const vocabulary = (text: string) =>
  text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter((word) => gist(word) !== "")

/** Whether Whisper may have written a word of yapd's, `spoken`, as `heard`: like it, or "and" for its "in", as it hears "Over in" as "Over and". */
const heardAs = (heard: string, spoken: string) => alike(heard, spoken) || (heard === "and" && spoken === "in")

/** Words heard, from `first` to `last`, taken for yapd's, from `start` to `end`. */
interface Match {
  readonly first: number
  readonly last: number
  readonly start: number
  readonly end: number
}

/**
 * How `words` line up, in order, with what yapd says, as near as Whisper
 * hears it, as many of them as can: each a word of its, two of its run
 * together, like "overin" for "over in", or split in two, like "of her" for
 * "over", skipping up to two of its words between, which Whisper drops, and
 * three of those heard, which it makes up, like "stop rage" for "storage", or
 * writes for one of its, like "tea three code" for "t3code".
 */
const lined = (words: ReadonlyArray<string>, yapd: ReadonlyArray<string>) => {
  // The most that line up with a match ending at each word heard and at each of yapd's, and the match that got there.
  const most = words.map(() => yapd.map(() => 0))
  const how = words.map(() => yapd.map((): { readonly match: Match; readonly from?: readonly [number, number] } | undefined => undefined))
  let best: readonly [number, number] | undefined
  words.forEach((_, last) => {
    yapd.forEach((_, end) => {
      for (const first of [last, last - 1]) {
        for (const start of [end, end - 1]) {
          if (first < 0 || start < 0 || !heardAs(words.slice(first, last + 1).join(""), yapd.slice(start, end + 1).join(""))) continue
          // Two heard for its only when it takes both, as for a name Whisper writes in two, like "home lab" for "homelab": not when
          // each is one of its already, nor one is its very word, so a word run on from one of its, like "yes" in "again, yes", isn't.
          if (first < last) {
            const spoken = yapd.slice(start, end + 1)
            const alone = [first, last].map((at) => spoken.some((word) => alike(words[at]!, word)))
            if (alone.every(Boolean) || [first, last].some((at) => spoken.some((word) => stem(word) === stem(words[at]!)))) continue
          }
          let before = 0
          let from: readonly [number, number] | undefined
          for (let earlier = Math.max(0, first - 4); earlier < first; earlier++) {
            for (let previous = Math.max(0, start - 3); previous < start; previous++) {
              if (most[earlier]![previous]! > before) [before, from] = [most[earlier]![previous]!, [earlier, previous]]
            }
          }
          // A word heard as its very word lines up a little better than one only like it, so "code codex" for "t3code Codex" is "codex" for "Codex".
          const exact = first === last && start === end && stem(words[first]!) === stem(yapd[start]!)
          const count = before + last - first + 1 - (exact ? 0 : 0.001)
          if (count <= most[last]![end]!) continue
          most[last]![end] = count
          how[last]![end] = { match: { first, last, start, end }, ...(from === undefined ? {} : { from }) }
          if (best === undefined || count > most[best[0]]![best[1]]!) best = [last, end]
        }
      }
    })
  })
  const matches: Array<Match> = []
  for (let at = best; at !== undefined; at = how[at[0]]![at[1]]!.from) matches.unshift(how[at[0]]![at[1]]!.match)
  return matches
}

/**
 * Which of `words` are yapd's: those in line with what it was saying, and
 * those in place of its words between two that are, which are those
 * misheard, like "Japan" for "yapd" in "Over in Japan, the tests", or, for
 * one of its words not just anything has, one more, as Whisper writes a name
 * in two, like "your app". A word or two just before them or just after, in
 * place of its word there, are that misheard when they sound like it, like
 * "Rick" for "rig" or "pool" for "pull". In line with only common words of
 * its, the same goes for its name beside them: a word or two after them when
 * what was heard starts with them, like "In Japan." or "Over in your app.",
 * and the word before when it ends with them, like "Japan, the.".
 */
const ours = (words: ReadonlyArray<string>, yapd: ReadonlyArray<string>) => {
  const matches = lined(words, yapd)
  const its = new Set<number>()
  /** Its words they're in line with, or in place of. */
  const said = new Set<number>()
  const named = (word: string | undefined): word is string => word !== undefined && !common.has(word)
  const anchored = matches.some((match) => yapd.slice(match.start, match.end + 1).some(named))
  matches.forEach((match, index) => {
    for (let at = match.first; at <= match.last; at++) its.add(at)
    for (let at = match.start; at <= match.end; at++) said.add(at)
    const next = matches[index + 1]
    if (next === undefined) return
    // Heard in place of some of its words between, no more of them than it said, they're those misheard, rather than put in among
    // them. For a word of its that not just anything has, its name, one more among words of its that tell its voice, and two when
    // they sound like it, like "your app" for "yapd" or "tea three code" for "t3code". Never a "not".
    const [between, skipped] = [words.slice(match.last + 1, next.first), yapd.slice(match.end + 1, next.start)]
    const name = skipped.some(named)
    const room = skipped.length + (name && near(between.join(""), skipped.join("")) ? 2 : name && anchored ? 1 : 0)
    if (between.length === 0 || between.length > room || between.some((word) => negations.has(word))) return
    for (let at = match.last + 1; at < next.first; at++) its.add(at)
    for (let at = match.end + 1; at < next.start; at++) said.add(at)
  })
  const [first, last] = [matches[0], matches.at(-1)]
  if (first === undefined || last === undefined) return its
  // In line with, or in place of, a word of its that not just anything has, which tells its voice.
  const telling = [...said].some((at) => !common.has(yapd[at]!))
  // Among words that tell its voice, a common one more, like the "is" of "the test is passed", is Whisper's way with it, but never a "not".
  if (telling) {
    for (let at = first.last + 1; at < last.first; at++) if (common.has(words[at]!) && !negations.has(words[at]!)) its.add(at)
  }
  const [previous, next] = [yapd[first.start - 1], yapd[last.end + 1]]
  const after = words.length - 1 - last.last
  // All that's heard before its words, a word or two, sounding like its word before them.
  const leading = first.first > 0 && first.first <= 2 && named(previous) && near(words.slice(0, first.first).join(""), previous)
  // How many heard after its words, two or one, sound like its next word.
  const trailing =
    next === undefined
      ? undefined
      : [Math.min(after, 2), 1].find((count) => count > 0 && count <= after && near(words.slice(last.last + 1, last.last + 1 + count).join(""), next))
  if (telling) {
    if (leading) for (let at = 0; at < first.first; at++) its.add(at)
    if (trailing !== undefined) for (let at = last.last + 1; at <= last.last + trailing; at++) its.add(at)
    return its
  }
  // All that's left, or, after two or more of its, the word or two in place of its next: more than that may be his own.
  const matched = matches.reduce((count, match) => count + match.last - match.first + 1, 0)
  if (named(next) && first.first === 0 && trailing !== undefined && (after <= 2 || matched >= 2)) {
    for (let at = last.last + 1; at <= last.last + trailing; at++) its.add(at)
    return its
  }
  if (first.first === 1 && after === 0 && leading) its.add(0)
  return its
}

/** What Whisper makes up of near-silence, or of a voice it can't make out, which nobody said, each as a sentence of its own, as it's compared. */
const inventions = [
  ...hallucinated, "the end", "end of song", "thank you very much", "thank you so much", "thanks for listening", "thank you for listening",
  "thank you for your attention", "see you next time", "i'll see you next time", "see you later", "see you soon", "see you in the next one",
  "i'll see you in the next one", "see you guys", "see you guys next time", "bye bye", "goodbye", "good night", "i'll be right back",
  "have a nice day", "have a good day", "take care", "good luck", "welcome back", "let's get started", "i'm sorry", "oh my god",
  "you know what i mean", "bon appétit", "peace out", "of course", "excuse me", "good morning", "good afternoon", "good evening",
  "what the hell", "jesus christ", "let's go", "here we go", "that's it", "that's all", "i'm going to go", "come on", "i don't know",
].map((phrase) => vocabulary(phrase).filter((word) => word.length > 1))

/** The same, without the fillers. */
const madeUp: ReadonlySet<string> = new Set(inventions.map((words) => words.filter((word) => !fillers.has(word)).join(" ")))

/** Those of nothing but fillers, like "Thank you." or "Bye bye.", which only these are of all such sentences. */
const filled: ReadonlySet<string> = new Set(inventions.filter((words) => words.every((word) => fillers.has(word))).map((words) => words.join(" ")))

/** Sentences, but not the dot in "Amara.org". */
const sentences = (heard: string) => heard.split(/[.!?]+(?=\s|$)/)

/**
 * The words of what was heard as they're compared, less what Whisper makes
 * up, single letters, and the words that only fill a pause. A sentence of
 * what it makes up is let go only whole, so none of his goes with it.
 */
const wordsOf = (heard: string, yapd: ReadonlyArray<string>) => {
  const said = sentences(heard)
    .map(vocabulary)
    .filter((sentence) => !sentence.some((word) => giveaways.has(word)))
    .filter(
      (sentence) =>
        !sentence.some((word) => tells.has(word)) ||
        !sentence.every((word) => tells.has(word) || fillers.has(word) || common.has(word) || word.length === 1 || yapd.includes(word)),
    )
    .map((sentence) => sentence.filter((word) => word.length > 1 && !fillers.has(word)))
    .filter((sentence) => !madeUp.has(sentence.join(" ")))
    .flat()
  // Whisper repeats itself on noise, so a word said again straight after counts once.
  return said.filter((word, index) => word !== said[index - 1])
}

/**
 * Whether all that was heard over a line yapd was `saying`, begun while its
 * own voice could still get into the microphone, may be only that voice,
 * going by Whisper's words, which this only ever tells by, never changes:
 * nothing, what Whisper makes up of a voice it can't make out, like "Thank
 * you." or "Thanks for watching.", or words of what it was saying, misheard
 * or not, like "Over in Japan" for "Over in yapd". Never with a word it
 * wasn't saying, nor with a sentence of only words that fill a pause Whisper
 * doesn't make up whole, like "Okay, thanks.", which may be him taking it in.
 */
export const own = (heard: string, saying: string) => {
  const yapd = vocabulary(saying)
  const its = (word: string) => yapd.some((spoken) => alike(word, spoken))
  const fill = sentences(heard)
    .map((sentence) => vocabulary(sentence).filter((word, index, words) => word.length > 1 && word !== words[index - 1]))
    .filter((sentence) => sentence.length > 0 && sentence.every((word) => fillers.has(word)))
  if (fill.some((sentence) => !filled.has(sentence.join(" ")) && !sentence.every(its))) return false
  const words = wordsOf(heard, yapd)
  const matched = ours(words, yapd)
  return words.every((word, index) => matched.has(index) || its(word))
}

/** Something yapd asks the user for itself, like which project new work is for, rendered and ready to be asked. */
export interface Question {
  readonly audio: string
  /** What it says, so its own voice getting into the microphone as it starts isn't taken for an answer. */
  readonly spoken: string
  /** Run once it starts playing the first time, which is when the user hears of it: never when it can't be played. */
  readonly saying?: Effect.Effect<void>
  /** Run each time it plays to the end, before the wait for an answer: the user has heard all of it, whatever they say next. */
  readonly through?: Effect.Effect<void>
  /** What its options are called, which what's said back is heard listening for, since Whisper mishears names it doesn't expect. */
  readonly terms?: ReadonlyArray<string>
  /** Like `saying`, but once it's known to be playing, which with afplay is only once it has played to the end. */
  readonly confirmed?: Effect.Effect<void>
  /**
   * Works out what the user meant by what they said, and how many seconds of
   * it were speech, which may be called again with all of it if they carry
   * on. What it returns is run once they've stopped, and none means it
   * wasn't an answer. With `echo`, what yapd was saying around when they
   * began, while its own voice could still get into the microphone: the
   * first words heard may be some of it, or their first word lost under it.
   */
  readonly answer: (heard: string, voiced: number, echo?: string) => Effect.Effect<Option.Option<Effect.Effect<void>>>
}

/** An answer to what the user asked yapd, rendered and ready to be said, which they can follow up as they can an update. */
export interface Answer extends Omit<Question, "answer"> {
  /** Works out what they meant by what they said over it or right after, as a question's `answer` does: none means it wasn't meant for yapd. */
  readonly followUp: Question["answer"]
  /** Run once it's been said to the end, before the wait for a follow-up, since the user has heard it by then. */
  readonly through?: Effect.Effect<void>
}

/**
 * Reads updates out while listening. Talking over yapd ducks it at once and
 * stops it once it's clearly speech; what the user said then decides whether it
 * stops there, answers, sends the agent a follow-up, or carries on. Begun
 * while its own voice could still get into the microphone, what he said may
 * be only that, which it picks up again from; otherwise it's taken whole as
 * ever, with what yapd was saying around then, which some of it may be.
 */
export const make = (options: {
  readonly dir: string
  /** Whether unrelated activity has made the update stale. */
  readonly moved: (update: Update) => Effect.Effect<boolean>
  /**
   * Delivers the follow-up, or queues it until the session can receive it,
   * using its latest thread; or says what came of it when that's more than
   * sent or queued, like held behind a turn waiting on the user.
   */
  readonly send: (update: Update, message: string) => Effect.Effect<"sent" | "queued" | { readonly said: string }, RelayError>
  /** Says how a follow-up went when the update it answers was cut off before yapd could. */
  readonly late: (update: Update, spoken: string, failed: boolean) => Effect.Effect<void>
  /** Something was said over an update and taken in, which takes the place of whatever yapd asked before. */
  readonly replied: Effect.Effect<void>
  /** yapd starts saying something back over an update, like an answer or word of a follow-up, which is then what the user heard last. */
  readonly saying: (update: Update, line: string) => Effect.Effect<void>
  /** Whether what the user said to send over an update would be held back as it could give a secret away, so their words are kept and logged nowhere. */
  readonly withholds: (update: Update, message: string) => Effect.Effect<boolean>
}) =>
  Effect.gen(function* () {
    const lifetime = yield* Effect.scope
    const audio = yield* Audio
    const vad = yield* Vad
    const transcriber = yield* Transcriber
    const responder = yield* Responder
    const voice = yield* Voice
    const persona = yield* Persona
    const journal = yield* Journal

    let ids = 0
    const fresh = () => ++ids

    /** Starts listening, if there's a microphone. That's only known once something plays. */
    const open = (scope: Scope.Scope) =>
      Effect.gen(function* () {
        const detect = yield* vad.make.pipe(Effect.option)
        if (Option.isNone(detect)) return undefined
        const microphone = yield* audio.microphone.pipe(Scope.extend(scope))
        if (Option.isNone(microphone)) return undefined
        const ear: Ear = { signals: yield* Queue.unbounded<Signal>(), deaf: false }
        const endpointer = new Endpointer.Endpointer()
        yield* Stream.fromQueue(microphone.value).pipe(
          Stream.mapEffect((frame) =>
            Effect.gen(function* () {
              // As the frame came in, since by the time it's looked at, yapd may well have learnt its own voice.
              const echo = yield* audio.echo(frame)
              const event = endpointer.push(frame, yield* detect.value(frame))
              return event?._tag === "Onset" ? ({ _tag: "Onset", echo } satisfies Signal) : event
            }),
          ),
          Stream.runForEach((event) => (event === undefined ? Effect.void : Queue.offer(ear.signals, event))),
          Effect.ignore,
          Effect.zipRight(
            Effect.suspend(() => {
              ear.deaf = true
              return Queue.offer(ear.signals, { _tag: "Deaf" })
            }),
          ),
          Effect.forkIn(scope),
        )
        return ear
      })

    /** The microphone for whatever is said in the scope, opened when it's first needed. */
    const hearing = (scope: Scope.Scope) => {
      let opened: Ear | undefined
      return Effect.suspend(() =>
        opened === undefined
          ? open(scope).pipe(
              Effect.tap((ear) => {
                opened = ear
              }),
            )
          : Effect.succeed(opened),
      )
    }

    /**
     * Plays a line, `text`, from `from` seconds, listening if there's an ear,
     * then `wait` longer for a reply. `begun` runs once it's playing, never
     * when it can't be played, `confirmed` once it's known to be, which with
     * afplay is only once it has played to the end, and `through` once it
     * has, before that wait: the user has heard it, whatever they say after.
     */
    const speak = (
      path: string,
      text: string,
      from: number,
      ear: Effect.Effect<Ear | undefined>,
      given: {
        readonly wait?: Duration.DurationInput
        readonly begun?: Effect.Effect<void>
        readonly confirmed?: Effect.Effect<void>
        readonly through?: Effect.Effect<void>
      } = {},
    ) =>
      Effect.gen(function* () {
        const { wait = linger, begun = Effect.void, confirmed = Effect.void, through = Effect.void } = given
        const playback = yield* audio.play(path, from)
        yield* begun
        if (playback.confirmed) yield* confirmed
        // Otherwise it's known only as it plays to the end, so it goes with what runs then, holding nothing up meanwhile.
        const played = playback.confirmed ? through : Effect.zipRight(confirmed, through)
        const listening = yield* ear
        if (listening === undefined || listening.deaf) {
          yield* playback.finished
          yield* played
          return { _tag: "Finished" } satisfies Outcome
        }
        return yield* listen(playback, listening, text, from, wait, played)
      }).pipe(Effect.scoped)

    const listen = (playback: Playback, ear: Ear, text: string, from: number, wait: Duration.DurationInput, through: Effect.Effect<void>) =>
      Effect.gen(function* () {
        const { signals } = ear
        const id = fresh()
        const began = yield* Clock.currentTimeMillis
        // Failing ends it too, or this could wait for a signal that never comes. Played to the end, it's heard
        // there and then, even when a stop asked for just before is still being answered: only playing to the
        // end finishes it, never being stopped.
        yield* playback.finished.pipe(
          Effect.tap(() =>
            Effect.zipRight(
              Effect.sync(() => {
                completed = true
              }),
              through,
            ),
          ),
          Effect.match({
            onFailure: (error): Signal => ({ _tag: "Broke", id, error }),
            onSuccess: (): Signal => ({ _tag: "Finished", id }),
          }),
          Effect.flatMap((signal) => Queue.offer(signals, signal)),
          Effect.forkScoped,
        )

        let playing = true
        /** Between an onset and the end of what the user said. */
        let speaking = false
        let deaf = false
        /** Why it broke off after being stopped for him to speak, like the helper quitting, which nothing after may hide. */
        let broken: AudioError | undefined
        /** Stopped for him to speak, rather than played to the end. */
        let cut = false
        /** Played to the end, even with a stop for him to speak still being answered. */
        let completed = false
        let stoppedAt: number | undefined
        /** How far into the line he began what he's saying, when that was while yapd's own voice could still get into the microphone. */
        let echoing: number | undefined
        let lingering: { readonly id: number; readonly fiber: Fiber.RuntimeFiber<void> } | undefined
        const stopLingering = Effect.suspend(() => {
          const fiber = lingering?.fiber
          lingering = undefined
          return fiber === undefined ? Effect.void : Fiber.interrupt(fiber)
        })
        const startLingering = Effect.gen(function* () {
          yield* stopLingering
          const id = fresh()
          const fiber = yield* Effect.sleep(wait).pipe(
            Effect.zipRight(Queue.offer(signals, { _tag: "Lingered", id })),
            Effect.asVoid,
            Effect.forkScoped,
          )
          lingering = { id, fiber }
        })
        const next = Effect.suspend(() =>
          speaking && !playing
            ? Queue.take(signals).pipe(
                Effect.timeout(patience),
                Effect.orElseSucceed((): Signal => ({ _tag: "Deaf" })),
              )
            : Queue.take(signals),
        )
        /** How far into the line yapd has got, in seconds. */
        const position = Effect.map(Clock.currentTimeMillis, (now) => stoppedAt ?? Math.min(playback.duration, from + (now - began) / 1000))

        while (true) {
          const signal = yield* next
          switch (signal._tag) {
            case "Onset":
              speaking = true
              echoing = signal.echo ? yield* position : undefined
              yield* stopLingering
              if (playing) yield* playback.volume(ducked)
              break
            case "Speech":
              yield* stopLingering
              if (playing) {
                playing = false
                cut = true
                stoppedAt = yield* playback.stop
              }
              break
            case "Abandoned":
              speaking = false
              if (playing) yield* playback.volume(1)
              else yield* startLingering
              break
            case "Utterance": {
              const at = stoppedAt ?? playback.duration
              return {
                _tag: "Interrupted",
                at,
                duration: playback.duration,
                audio: signal.audio,
                ear,
                // To where it stopped, or where he began, should the helper put that a moment before.
                ...(echoing === undefined
                  ? {}
                  : { echo: between(text, playback.duration, echoing - reach, Math.max(at, echoing) + reach), onset: Math.min(at, echoing) }),
              } satisfies Outcome
            }
            case "Finished":
              // Heard already, as it finished. Also arrives for a playback the user stopped, which is already dealt with.
              if (signal.id !== id || !playing) break
              playing = false
              if (deaf) return { _tag: "Finished" } satisfies Outcome
              if (!speaking) yield* startLingering
              break
            case "Broke":
              if (signal.id !== id) break
              // Stopped for him to speak, it waits on what he says, unless nothing comes of it.
              if (!playing) {
                broken = signal.error
                break
              }
              // As without a microphone: cut short, it wasn't heard, and there's nothing to wait for a reply to.
              return yield* Effect.fail(signal.error)
            case "Lingered":
              if (signal.id !== lingering?.id) break
              if (broken !== undefined) return yield* Effect.fail(broken)
              return { _tag: "Finished" } satisfies Outcome
            case "Deaf":
              deaf = true
              if (broken !== undefined) return yield* Effect.fail(broken)
              // Stopped for him to speak, and gone deaf before he'd finished, it was never heard to the end, nor what he said.
              if (cut && !completed) return yield* Effect.fail(new AudioError({ message: "The microphone went away while he was talking over it" }))
              if (!playing) return { _tag: "Finished" } satisfies Outcome
              yield* playback.volume(1)
              break
            case "Replied":
              break
          }
        }
      })

    /**
     * Works out a reply while still listening, so pausing mid-thought doesn't cut
     * the user off: if they carry on before it's ready, it starts again with all
     * they said, and how many seconds of all of it were speech. Nothing's done
     * with a reply while they might still be talking.
     */
    const settle = <R>(
      ear: Ear,
      first: string,
      audio: Float32Array,
      transcribe: (audio: Float32Array) => Effect.Effect<string>,
      respond: (heard: string, voiced: number) => Effect.Effect<R>,
    ) =>
      Effect.gen(function* () {
        const until = (yield* Clock.currentTimeMillis) + rambling
        let heard = first
        let speech = voiced(audio)
        while (true) {
          const replying = unfinished(heard) ? Effect.zipRight(Effect.sleep(hesitation), respond(heard, speech)) : respond(heard, speech)
          if (ear.deaf || (yield* Clock.currentTimeMillis) > until) return { heard, reply: yield* replying }
          const id = fresh()
          const fiber = yield* replying.pipe(
            Effect.flatMap((reply) => Queue.offer(ear.signals, { _tag: "Replied", id, reply })),
            Effect.fork,
          )

          let speaking = false
          let carryingOn = false
          let held: R | undefined
          let more: Float32Array | undefined
          waiting: while (true) {
            const signal = yield* (speaking || carryingOn)
              ? Queue.take(ear.signals).pipe(
                  Effect.timeout(patience),
                  Effect.orElseSucceed((): Signal => ({ _tag: "Deaf" })),
                )
              : Queue.take(ear.signals)
            switch (signal._tag) {
              case "Replied":
                // Once they carry on, even one that got in before it was stopped is out of date.
                if (signal.id !== id || carryingOn) break
                // Only this call's replies carry its id.
                if (!speaking) return { heard, reply: signal.reply as R }
                held = signal.reply as R
                break
              case "Onset":
                speaking = true
                break
              case "Abandoned":
                speaking = false
                if (held !== undefined) return { heard, reply: held }
                break
              case "Speech":
                carryingOn = true
                held = undefined
                yield* Fiber.interrupt(fiber)
                break
              case "Utterance":
                more = signal.audio
                break waiting
              case "Deaf":
                speaking = false
                if (carryingOn) break waiting
                if (held !== undefined) return { heard, reply: held }
                break
              case "Finished":
              case "Broke":
              case "Lingered":
                break
            }
          }
          yield* Fiber.interrupt(fiber)
          if (more === undefined) continue
          const after = yield* transcribe(more)
          heard = together(heard, after)
          // Only what added words, since speech Whisper made nothing of isn't in what was heard.
          if (after !== "") speech += voiced(more)
        }
      })

    /** Follow-ups on their way, each attached to the update it answers, with its own mark, so one ending doesn't clear a later one. */
    const sending = new Map<Update, object>()

    /**
     * Sends a follow-up and returns what to say about it. Once the user has said
     * it, it's sent whatever happens to the conversation, like a dictation
     * cutting it off: what's then left unsaid is said later.
     */
    const pass = (update: Update, reply: Reply) =>
      Effect.gen(function* () {
        let failed = false
        const mark = {}
        sending.set(update, mark)
        const lines = yield* persona.lines
        const fiber = yield* follow(update, reply.message).pipe(
          Effect.flatMap((result) =>
            typeof result === "object"
              ? Effect.succeed(result.said)
              : result === "queued"
                ? Effect.succeed(lines.queued)
                : reply.spoken === ""
                  ? persona.onIt()
                  : Effect.succeed(reply.spoken),
          ),
          Effect.catchAll((error) =>
            Effect.logWarning("Could not send the follow-up", { reason: error.reason, error }).pipe(
              Effect.tap(() => {
                failed = true
              }),
              Effect.as(error.reason),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (sending.get(update) === mark) sending.delete(update)
            }),
          ),
          Effect.annotateLogs({ project: update.project }),
          Effect.forkIn(lifetime),
        )
        return yield* Fiber.join(fiber).pipe(
          Effect.onInterrupt(() =>
            Fiber.join(fiber).pipe(
              Effect.flatMap((spoken) => options.late(update, spoken, failed)),
              Effect.forkIn(lifetime),
            ),
          ),
        )
      })

    const follow = (update: Update, message: string) =>
      Effect.gen(function* () {
        // Typing into a session that started something else would steer it, or answer one of its prompts.
        if (yield* options.moved(update)) return yield* new RelayError({ reason: movedOn })
        const text = plain(message)
        const result = yield* options.send(update, text)
        yield* Effect.logInfo(`${result === "queued" ? "Queued" : typeof result === "object" ? "Held" : "Sent"}: ${text}`)
        return result
      })

    /** What the user said, logged once it's known it's fit to be, as what's said over an update may not be; listening for `terms`, when there are any. */
    const unlogged = (audio: Float32Array, terms?: ReadonlyArray<string>) =>
      transcriber.transcribe(audio, terms).pipe(Effect.catchAll((error) => Effect.logWarning("Could not transcribe", error).pipe(Effect.as(""))))

    const transcribe = (audio: Float32Array, terms?: ReadonlyArray<string>) =>
      unlogged(audio, terms).pipe(Effect.tap((heard) => (heard === "" ? Effect.void : Effect.logInfo(`Heard: ${heard}`))))

    /**
     * What's known of yapd's own voice in what he said over a line, heard as
     * `first`: whether it was only that, as `own` tells, so yapd stopped for
     * itself and picks up again, saying nothing and asking nobody, as that
     * does no harm; or else what it was saying around when he began, which
     * some of what was heard may be. Neither for what he began once its own
     * voice was learnt. Speech that went on past where it stopped is someone
     * else's, which its own voice dying away can't be, so only nothing, or
     * what Whisper makes up, is taken for its own then; and when it had said
     * all of it by then, its own voice can only be its last word or so
     * before him, as after any line, so the model isn't told.
     */
    const whose = (outcome: Extract<Outcome, { readonly _tag: "Interrupted" }>, first: string) =>
      Effect.gen(function* () {
        const { echo, onset = outcome.at } = outcome
        if (echo === undefined) return { itself: false }
        const past = voiced(outcome.audio) - Math.max(0, outcome.at - onset) > overhang
        if (own(first, "") || (!past && own(first, echo))) {
          yield* Effect.logInfo("Stopped for its own voice over its first seconds, so it picks up again")
          return { itself: true }
        }
        return { itself: false, ...(past && outcome.at >= outcome.duration - ending ? {} : { echo }) }
      })

    /**
     * Reads an update out and talks it over. `through` runs as soon as the
     * update itself has been read to the end, even with the microphone still
     * open for a reply, since the user has heard it by then.
     */
    const converse = (update: Update, through: Effect.Effect<void> = Effect.void) =>
      Effect.suspend(() => {
        const rendered: Array<string> = []
        return Effect.gen(function* () {
          const ear = hearing(yield* Effect.scope)
          const lines: Array<Line> = []
          let text = update.spoken
          let path = update.audio
          let from = 0
          let missed = 0

          while (true) {
            const outcome: Outcome = yield* speak(path, text, from, missed < misses ? ear : Effect.succeed(undefined), {
              // Noted only once it's known to play, so a line for going ahead that fails to render or play, or that a dictation cuts in before, never counts as the last one he heard.
              confirmed: path === update.audio ? Effect.void : persona.said(text),
              through: path === update.audio ? through : Effect.void,
            })
            if (outcome._tag === "Finished") return
            // Replying to something yapd had finished saying: there's nothing to go back to.
            const after = outcome.at >= outcome.duration
            // Always forward, so talk that keeps coming can't hold an update back forever.
            const carryOn = () => {
              missed++
              from = Math.max(from, outcome.at - rewind)
            }

            const first = yield* unlogged(outcome.audio)
            const { itself, echo } = yield* whose(outcome, first)
            // Not talk that wasn't meant for yapd, which it stops listening after so much of: only over its first seconds.
            if (itself) {
              if (after) return
              from = Math.max(from, outcome.at - before)
              continue
            }
            if (first === "") {
              if (after) return
              carryOn()
              continue
            }

            const said = cut(text, outcome.duration > 0 ? outcome.at / outcome.duration : 1)
            const { heard, reply } = yield* settle(outcome.ear, first, outcome.audio, unlogged, (heard) =>
              responder
                .respond({
                  project: update.project,
                  turn: update.turn,
                  needsYou: update.needsYou,
                  lines: [...lines, { speaker: "yapd", text: said }],
                  heard,
                  ...(echo === undefined ? {} : { echo }),
                })
                .pipe(
                  Effect.catchAll((error) =>
                    Effect.logWarning("Could not reply", error).pipe(
                      Effect.zipRight(persona.lines),
                      Effect.map((lines): Reply => ({ intent: "answer", spoken: lines.misheard, message: "" })),
                    ),
                  ),
                ),
            )
            // Held back as it could give a secret away, it's kept and logged nowhere: whether it is, is known before either.
            const withheld = reply.intent === "send" && (yield* options.withholds(update, plain(reply.message)))
            yield* Effect.logInfo(withheld ? "Heard something to send that could give a secret away, so it's held back" : `Heard: ${heard}`)
            yield* Effect.logInfo(`Reply: ${reply.intent}${reply.spoken === "" ? "" : `, saying: ${reply.spoken}`}`)
            if (reply.intent !== "resume") {
              yield* journal.write({
                at: yield* Clock.currentTimeMillis,
                kind: "reply",
                host: update.thread.origin.host,
                project: update.project,
                // With the thread T3 Code knows it by, when it's tied to one, like the update itself.
                ...(update.about === undefined ? { thread: update.session } : { machine: update.about.machine, thread: update.about.id }),
                directory: update.thread.cwd,
                said: reply.spoken,
                ...(withheld ? {} : { text: heard }),
                detail: { intent: reply.intent, ...(reply.message === "" || withheld ? {} : { message: reply.message }), ...(withheld ? { withheld } : {}) },
              })
              yield* options.replied
            }

            if (reply.intent === "dismiss") return
            if (reply.intent === "resume") {
              if (after) return
              // Taken by the model for its own voice, it's no more talk that wasn't meant for yapd than when `own` tells so.
              if (echo === undefined) carryOn()
              else from = Math.max(from, outcome.at - before)
              continue
            }

            lines.push({ speaker: "yapd", text: said }, { speaker: "user", text: heard })
            text =
              reply.intent === "send"
                ? yield* pass(update, reply)
                : reply.spoken
            if (text === "") return
            path = join(options.dir, `${crypto.randomUUID()}${extension}`)
            rendered.push(path)
            yield* voice.render(text, path)
            yield* options.saying(update, text)
            from = 0
            missed = 0
          }
        }).pipe(
          Effect.scoped,
          Effect.ensuring(Effect.promise(() => Promise.all(rendered.map((path) => rm(path, { force: true }))))),
          Effect.annotateLogs({ project: update.project }),
        )
      })

    /**
     * Says something of yapd's own and listens for what the user says over it
     * or `wait` after, like with an update: `respond` works out what they
     * meant, and what it gives back is run once they've stopped. Talk it
     * makes nothing of picks up where it cut in, unless it came once all of
     * it was said. Its `through` runs each time it's said to the end, and
     * what they say is heard listening for its `terms`. Returns whether
     * something came of what they said, and fails when it can't be played or
     * breaks off.
     */
    const exchange = (said: Omit<Question, "answer">, respond: Question["answer"], wait: Duration.DurationInput) =>
      Effect.gen(function* () {
        const ear = hearing(yield* Effect.scope)
        // Listening for its options, if it has any, all of what he says back, however long he goes on.
        const hear = (audio: Float32Array) => transcribe(audio, said.terms)
        let from = 0
        let missed = 0
        let begun = said.saying ?? Effect.void
        let confirmed = said.confirmed ?? Effect.void
        while (true) {
          const outcome: Outcome = yield* speak(said.audio, said.spoken, from, missed < misses ? ear : Effect.succeed(undefined), {
            wait,
            begun,
            confirmed,
            through: said.through ?? Effect.void,
          })
          begun = Effect.void
          confirmed = Effect.void
          if (outcome._tag === "Finished") return false
          const first = yield* hear(outcome.audio)
          // Its own voice, over its first seconds, is no answer, nor talk that wasn't meant for yapd.
          const { itself, echo } = yield* whose(outcome, first)
          const reply =
            itself || first === ""
              ? Option.none()
              : (yield* settle(outcome.ear, first, outcome.audio, hear, (heard, voiced) => respond(heard, voiced, echo))).reply
          if (Option.isSome(reply)) {
            // They've answered or followed it up, so it's taken in even if a dictation starts right now.
            yield* Effect.uninterruptible(reply.value)
            return true
          }
          // Talk that wasn't meant for yapd, once all of it was said, ends it: a question is left unanswered.
          if (outcome.at >= outcome.duration) return false
          // Nor is what may have been its own voice, as `respond` was told, which is picked up just before.
          if (itself || echo !== undefined) {
            from = Math.max(from, outcome.at - before)
            continue
          }
          missed++
          from = Math.max(from, outcome.at - rewind)
        }
      }).pipe(Effect.scoped)

    /**
     * Asks the user something and listens for what they say over it or right
     * after, like with an update. Returns whether they answered, and fails
     * when it can't be played or breaks off.
     */
    const ask = (question: Question) => exchange(question, question.answer, pondering)

    /**
     * Says an answer to what the user asked and listens for a follow-up over
     * it or right after, for as long as after an update, since it's what they
     * asked to hear rather than something they're asked. Returns whether they
     * followed it up, and fails when it can't be played or breaks off.
     */
    const answer = (said: Answer) => exchange(said, said.followUp, linger)

    return {
      converse,
      ask,
      answer,
      /** Whether a follow-up to the session, or this particular update, is on its way. */
      sending: (session: string, update?: Update) => Effect.sync(() =>
        update === undefined ? [...sending.keys()].some((update) => update.session === session) : sending.has(update),
      ),
    }
  })
