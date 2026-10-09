import { Clock, type Duration, Effect, Fiber, Option, Queue, Scope, Stream } from "effect"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { Audio, AudioError, type Playback } from "./Audio.ts"
import type { Turn } from "./Condenser.ts"
import * as Endpointer from "./Endpointer.ts"
import { plain, RelayError, type Thread } from "./Relay.ts"
import { Journal } from "./Journal.ts"
import { Persona } from "./Persona.ts"
import { enough, gist, hallucinated, type Line, type Reply, Responder } from "./Responder.ts"
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
}

type Signal =
  | Exclude<Endpointer.Event, { readonly _tag: "Onset" | "Utterance" }>
  /** Might be the user, or with `echo`, yapd's own voice getting into the microphone, as it can until the echo cancellation has learnt it. */
  | { readonly _tag: "Onset"; readonly echo: boolean }
  /** They've finished. Begun just after yapd stopped talking, with the last of its voice still coming in, it's `fading`, since that's what it may be. */
  | { readonly _tag: "Utterance"; readonly audio: Float32Array; readonly fading?: boolean }
  /** All the user has said so far of what may be yapd's own voice, passed on as it goes, so a stop of his needn't wait till he's finished. */
  | { readonly _tag: "Partial"; readonly audio: Float32Array }
  /** The microphone stopped, like when the helper quits. */
  | { readonly _tag: "Deaf" }
  /** The rest carry the id of what sent them, so one that's no longer waited on is let go. */
  | { readonly _tag: "Finished"; readonly id: number }
  /** The playback broke off, like when the audio helper quits: what it played wasn't heard to the end. */
  | { readonly _tag: "Broke"; readonly id: number; readonly error: AudioError }
  | { readonly _tag: "Lingered"; readonly id: number }
  /** The reply is whatever the one who asked for it works out: what to do about an update, or an answer to a question. */
  | { readonly _tag: "Replied"; readonly id: number; readonly reply: unknown }
  /** Whisper's words for what may have been yapd's own voice, whose voice they were, and what's taken of them: none when it's unclear. */
  | { readonly _tag: "Looked"; readonly id: number; readonly heard: string; readonly whose: Whose; readonly taken: string }

/**
 * The microphone for a whole update, so nothing the user says is missed
 * between lines, like while yapd works out what to say back.
 */
interface Ear {
  readonly signals: Queue.Queue<Signal>
  deaf: boolean
}

/**
 * Some of what the user said over a line, and what's taken of Whisper's words
 * for it when they were needed to tell it from yapd's own voice: all of them,
 * or only his stop.
 */
interface Piece {
  readonly audio: Float32Array
  readonly heard?: string
}

/** How a line went: played out, or talked over, with what the user said. */
type Outcome =
  | { readonly _tag: "Finished" }
  | {
      readonly _tag: "Interrupted"
      /** How far it got, in seconds: no further than where he began, when it carried on over him until it made out it was him. */
      readonly at: number
      readonly duration: number
      /** All he said, and the same in the pieces it's made out in: none when it all turned out unclear, once yapd had stopped for it. */
      readonly audio: Float32Array
      readonly said: ReadonlyArray<Piece>
      readonly ear: Ear
      /** What yapd was saying as it stopped, the last of which may still come in after, as he carries on. */
      readonly last: string
    }

type Interrupted = Extract<Outcome, { readonly _tag: "Interrupted" }>

/** Something the user said over a line, kept in order while what came before it may yet turn out to be yapd's own voice. */
interface Talk {
  /** What passes on what was made of it, when it had to be. */
  readonly id: number
  readonly audio: Float32Array
  /** How far into the line it began, when yapd carried on over it: none when it stopped for it at once. */
  readonly at: number | undefined
  /** Whose voice it was, unknown while it's being made out, and what's taken of Whisper's words for it once they are. */
  whose: Whose | undefined
  heard: string | undefined
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

/** Frames of what may be yapd's own voice between each look at all of it so far, while it goes on, for a stop of his: about a second. */
const glance = Math.round(rate / frame)

/** Seconds either side of the user talking that yapd's words are looked for in what he said, since where each falls in a line is only guessed. */
const reach = 4

/** What a look at what's been said so far heard, less its last word, which the audio may cut through, and Whisper hear as anything, even "stop". */
const cutShort = (heard: string) => heard.split(/\s+/).filter((word) => word !== "").slice(0, -1).join(" ")

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
          if (first < 0 || start < 0 || !alike(words.slice(first, last + 1).join(""), yapd.slice(start, end + 1).join(""))) continue
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

/**
 * What can only be for yapd to stop or wait, wherever it comes in what he
 * says: as he'd say it on its own, and as it's compared, without single
 * letters, the longest first, so all of "wait a second" is taken.
 */
const halting = [
  ...enough, "not now", "wait", "hold on", "hang on", "pause", "one second", "one sec", "just a second", "wait a second", "wait a minute",
]
  .map((phrase) => ({ said: `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}.`, words: vocabulary(phrase).filter((word) => word.length > 1) }))
  .sort((one, other) => other.words.length - one.words.length)

/**
 * Whether yapd is saying `word` itself, or a word it's the start of, like
 * "stop" of "stopped" or "wait" of "waiting": never one only like it, like
 * "not" for "now", "wait" for "want" or "stop" for "step".
 */
const says = (word: string, yapd: ReadonlyArray<string>) =>
  yapd.some((spoken) => stem(spoken) === stem(word) || (word.length >= 4 && spoken.startsWith(word)))

/**
 * The first stop or wait he said in `words`, as he'd say it on its own: none
 * when there's none with a word yapd isn't saying itself, nor saying run
 * together with a word heard beside it, like the "stop" of "stop rage" for
 * "storage".
 */
const halted = (words: ReadonlyArray<string>, yapd: ReadonlyArray<string>) => {
  const named = yapd.filter((word) => !common.has(word))
  const its = (at: number) =>
    says(words[at]!, yapd) ||
    [words[at - 1], words[at + 1]].some(
      (beside, side) => beside !== undefined && named.some((spoken) => alike(side === 0 ? `${beside}${words[at]}` : `${words[at]}${beside}`, spoken)),
    )
  for (let start = 0; start < words.length; start++) {
    const found = halting.find(
      (phrase) => phrase.words.every((word, index) => words[start + index] === word) && phrase.words.some((_, index) => !its(start + index)),
    )
    if (found !== undefined) return found.said
  }
  return undefined
}

/** What Whisper makes up of near-silence, or of a voice it can't make out, which nobody said, as a sentence of its own and without the fillers. */
const madeUp: ReadonlySet<string> = new Set(
  [
    ...hallucinated, "the end", "end of song", "thank you very much", "thank you so much", "thanks for listening", "thank you for listening",
    "thank you for your attention", "see you next time", "i'll see you next time", "see you later", "see you soon", "see you in the next one",
    "i'll see you in the next one", "see you guys", "see you guys next time", "bye bye", "goodbye", "good night", "i'll be right back",
    "have a nice day", "have a good day", "take care", "good luck", "welcome back", "let's get started", "i'm sorry", "oh my god",
    "you know what i mean", "bon appétit", "peace out", "of course", "excuse me", "good morning", "good afternoon", "good evening",
    "what the hell", "jesus christ", "let's go", "here we go", "that's it", "that's all", "i'm going to go", "come on", "i don't know",
  ].map((phrase) => vocabulary(phrase).filter((word) => word.length > 1 && !fillers.has(word)).join(" ")),
)

/**
 * The words of what was heard as they're compared, less what Whisper makes
 * up, single letters, and the words that only fill a pause. A sentence of
 * what it makes up is let go only whole, so none of his goes with it.
 */
const wordsOf = (heard: string, yapd: ReadonlyArray<string>) => {
  const said = heard
    // Sentences, but not the dot in "Amara.org".
    .split(/[.!?]+(?=\s|$)/)
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

/** What's heard over yapd while its own voice can still get into the microphone comes to: a stop or a wait of his, all his, or unclear, which is let go. */
export type Whose = "stop" | "his" | "unclear"

/**
 * Whether `words` can only be his: none but those nearly anything has in
 * line with what it was saying, its name misheard and all, nor, wherever it
 * comes, like a word of its: a letter or so apart, sounding like it, or the
 * start of it cut off. Nothing but words nearly anything has, they're his
 * only with some it isn't saying and no two it says one after another, like
 * "Not now." or "Why did it do that?", but not "Over in your".
 */
const clearly = (words: ReadonlyArray<string>, yapd: ReadonlyArray<string>) => {
  if (words.length === 0) return false
  /** Whether a word heard is its word `at`. */
  const said = (word: string, at: number) => at >= 0 && stem(word) === stem(yapd[at]!)
  if (words.every((word) => common.has(word))) {
    const unsaid = words.some((word) => !yapd.some((_, at) => said(word, at)))
    const inOrder = words.some((word, index) => index > 0 && yapd.some((_, at) => said(word, at) && said(words[index - 1]!, at - 1)))
    return unsaid && !inOrder
  }
  const its = ours(words, yapd)
  return words.every((word, index) => common.has(word) || !(its.has(index) || yapd.some((spoken) => alike(word, spoken))))
}

/**
 * Whose voice was heard over a line yapd was `saying`, before the echo
 * cancellation had learnt its voice, going by Whisper's words, which this
 * only ever tells by, never changes. His, when it clearly is, as `clearly`
 * has it, and more than what Whisper makes up, like "That's it.", so all of
 * it is taken. Otherwise a stop: a "stop" or "wait" he said that isn't a word
 * of its, though some of the rest may be its voice, so only that is taken.
 * Anything else is unclear, its own voice or what may be, and let go: he
 * says it again.
 */
export const whose = (heard: string, saying: string): Whose => {
  const yapd = vocabulary(saying)
  const words = wordsOf(heard, yapd)
  if (clearly(words, yapd)) return "his"
  return halted(words, yapd) === undefined ? "unclear" : "stop"
}

/** The stop or wait of his in what was heard over a line yapd was `saying`, as he'd say it on its own: none when there's none. */
export const stopIn = (heard: string, saying: string) => {
  const yapd = vocabulary(saying)
  return halted(wordsOf(heard, yapd), yapd)
}

/**
 * Whose voice was heard over a line yapd was `saying`, and what's taken of
 * it: all of it, as Whisper heard it, when it's clearly his, only his stop
 * or wait for a stop, and none when it's unclear. `soFar`, it's what he's
 * said until now, in which only a stop of his counts, heard in full before
 * the last word, which the audio may cut through.
 */
const taking = (heard: string, saying: string, soFar: boolean): { readonly whose: Whose; readonly taken: string } => {
  const told = soFar ? undefined : whose(heard, saying)
  if (told === "his") return { whose: told, taken: heard }
  const stop = told === "unclear" ? undefined : stopIn(soFar ? cutShort(heard) : heard, saying)
  return stop === undefined ? { whose: "unclear", taken: "" } : { whose: "stop", taken: stop }
}

/** Something yapd asks the user for itself, like which project new work is for, rendered and ready to be asked. */
export interface Question {
  readonly audio: string
  /** What it says, so its own voice getting into the microphone as it starts isn't taken for an answer. */
  readonly spoken: string
  /** Run once it starts playing the first time, which is when the user hears of it: never when it can't be played. */
  readonly saying?: Effect.Effect<void>
  /** Like `saying`, but once it's known to be playing, which with afplay is only once it has played to the end. */
  readonly confirmed?: Effect.Effect<void>
  /**
   * Works out what the user meant by what they said, and how many seconds of
   * it were speech, which may be called again with all of it if they carry
   * on. What it returns is run once they've stopped, and none means it
   * wasn't an answer.
   */
  readonly answer: (heard: string, voiced: number) => Effect.Effect<Option.Option<Effect.Effect<void>>>
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
 * stops it once it's clearly speech; what the user said then, word for word,
 * decides whether it stops there, answers, sends the agent a follow-up, or
 * carries on. While its own voice can still get into the microphone, it
 * carries on over him until he's finished and Whisper's words tell it's
 * clearly him, taking them all, or a stop or wait of his, taking only that;
 * anything else is let go, and he says it again.
 */
export const make = (options: {
  readonly dir: string
  /** Whether unrelated activity has made the update stale. */
  readonly moved: (update: Update) => Effect.Effect<boolean>
  /** Delivers the follow-up, or queues it until the session can receive it, using its latest thread. */
  readonly send: (update: Update, message: string) => Effect.Effect<"sent" | "queued", RelayError>
  /** Says how a follow-up went when the update it answers was cut off before yapd could, noting it with the persona once it plays. */
  readonly late: (update: Update, spoken: string, failed: boolean) => Effect.Effect<void>
  /** Something was said over an update and taken in, which takes the place of whatever yapd asked before. */
  readonly replied: Effect.Effect<void>
  /** yapd starts saying something back over an update, like an answer or word of a follow-up, which is then what the user heard last. */
  readonly saying: (update: Update, line: string) => Effect.Effect<void>
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
        /** Whether what's being said began while yapd's own voice could still get into the microphone, or once it had stopped, with the last of it still coming in. */
        let unsure = false
        let fading = false
        /** Frames of that since all of it was last passed on, once it's speech. */
        let since: number | undefined
        const reset = () => {
          unsure = false
          fading = false
          since = undefined
        }
        yield* Stream.fromQueue(microphone.value).pipe(
          Stream.mapEffect((frame) =>
            Effect.gen(function* () {
              const echo = yield* audio.echo(frame)
              const event = endpointer.push(frame, yield* detect.value(frame))
              if (event === undefined) {
                // Only while he talks, since a pause may be the end of what he said, which is then made out whole.
                if (since === undefined || endpointer.pausing || ++since < glance) return undefined
                since = 0
                return { _tag: "Partial", audio: endpointer.soFar() } satisfies Signal
              }
              switch (event._tag) {
                case "Onset":
                  // As it starts, since by the time it's made out, yapd may well have learnt its own voice. Only
                  // while it talks: what begins as it stops is far likelier him answering than the last of its voice.
                  unsure = echo === "talking"
                  fading = echo === "fading"
                  return { _tag: "Onset", echo: unsure } satisfies Signal
                case "Speech":
                  since = unsure ? 0 : undefined
                  return event
                case "Utterance": {
                  const faded = fading
                  reset()
                  return { _tag: "Utterance", audio: event.audio, ...(faded ? { fading: true } : {}) } satisfies Signal
                }
                case "Abandoned":
                  reset()
                  return event
              }
            }),
          ),
          Stream.runForEach((signal) => (signal === undefined ? Effect.void : Queue.offer(ear.signals, signal))),
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
     * Plays a line from `from` seconds, listening if there's an ear, then
     * `wait` longer for a reply. `text` is what it says, which tells yapd's own
     * voice getting into the microphone from the user. `begun` runs once it's
     * playing, never when it can't be played, `confirmed` once it's known to
     * be, which with afplay is only once it has played to the end, and
     * `through` once it has, before that wait: the user has heard it, whatever
     * they say after.
     */
    const speak = (
      path: string,
      from: number,
      ear: Effect.Effect<Ear | undefined>,
      given: {
        readonly text?: string
        readonly wait?: Duration.DurationInput
        readonly begun?: Effect.Effect<void>
        readonly confirmed?: Effect.Effect<void>
        readonly through?: Effect.Effect<void>
      } = {},
    ) =>
      Effect.gen(function* () {
        const { text = "", wait = linger, begun = Effect.void, confirmed = Effect.void, through = Effect.void } = given
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
        return yield* listen(playback, listening, { text, from }, wait, played)
      }).pipe(Effect.scoped)

    /**
     * Listens over a line, `text` played from `from` seconds, and stops it as
     * soon as the user talks over it. Talk that begins while yapd's own voice
     * can still get into the microphone may be just that, so yapd carries on
     * over it until Whisper's words for all of it, once he's finished, tell
     * it's clearly him, or a stop or wait of his, and lets it go otherwise. A
     * stop or wait of his, heard in full while he goes on, stops it sooner.
     */
    const listen = (
      playback: Playback,
      ear: Ear,
      line: { readonly text: string; readonly from: number },
      wait: Duration.DurationInput,
      through: Effect.Effect<void>,
    ) =>
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
        /**
         * Talk that began while yapd's own voice could still get into the
         * microphone, until it ends: how far into the line it began, and the
         * look at it so far under way, for a stop of his.
         */
        let doubt: { readonly at: number; looking: number | undefined } | undefined
        /** Talk that ended while some of it is still being made out, in the order it was said, so none of his is lost or put out of order. */
        const pending: Array<Talk> = []
        /** One look at a time, so Whisper never works on two at once. */
        const whisper = yield* Effect.makeSemaphore(1)
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
        const position = Effect.map(Clock.currentTimeMillis, (now) => stoppedAt ?? Math.min(playback.duration, line.from + (now - began) / 1000))
        /** Stops yapd for him to speak. */
        const halt = Effect.gen(function* () {
          playing = false
          cut = true
          stoppedAt = yield* playback.stop
        })
        /**
         * Makes out whose voice talk begun `at` seconds into the line is, by
         * what yapd was saying around it, without holding up playing or
         * listening, and passes that on with the id it returns. `soFar`, it's
         * what he's said until now, in which only a stop of his counts,
         * heard in full before the last word, which the audio may cut
         * through: nothing else is told of it till he's finished.
         */
        const look = (audio: Float32Array, at: number, soFar = false) =>
          Effect.gen(function* () {
            const id = fresh()
            const saying = between(line.text, playback.duration, at - reach, (yield* position) + reach)
            yield* transcriber.transcribe(audio).pipe(
              Effect.catchAll((error) => Effect.logWarning("Could not transcribe", error).pipe(Effect.as(""))),
              whisper.withPermits(1),
              Effect.flatMap((heard) => Queue.offer(signals, { _tag: "Looked", id, heard, ...taking(heard, saying, soFar) })),
              Effect.forkScoped,
            )
            return id
          })
        const interrupted = (said: ReadonlyArray<Piece>, began = Number.POSITIVE_INFINITY): Outcome => ({
          _tag: "Interrupted",
          // Stopped for him only once it made out it was him, it goes back to where he began, as it would have stopped there otherwise.
          // Played to the end meanwhile, there's nothing to go back to.
          at: completed ? playback.duration : Math.min(stoppedAt ?? playback.duration, began),
          duration: playback.duration,
          audio: said.length === 1 ? said[0]!.audio : Endpointer.concat(said.map((piece) => piece.audio)),
          said,
          ear,
          last: between(line.text, playback.duration, (stoppedAt ?? playback.duration) - reach, (stoppedAt ?? playback.duration) + reach),
        })
        /**
         * What he said over the line, once none of it is still being made out
         * and he's finished whatever he went on to say: none until then, nor
         * when all of it was unclear, which is let go, unless yapd had stopped
         * for it, as a look at some of it found a stop of his. Of what he said
         * while its own voice could get in, only what's taken of it is, all of
         * it or his stop.
         */
        const heardOut = () => {
          if (pending.length === 0 || pending.some((talk) => talk.whose === undefined)) return undefined
          if (speaking && !deaf && pending.some((talk) => talk.whose !== "unclear")) return undefined
          const talks = pending.splice(0)
          const taken = talks.filter((talk) => talk.whose !== "unclear")
          const from = (talks: ReadonlyArray<Talk>) => Math.min(...talks.map((talk) => talk.at ?? Number.POSITIVE_INFINITY))
          // Then it picks up from before where he began, as when what he said wasn't meant for it.
          if (taken.length === 0) return cut && !completed && !speaking ? interrupted([], from(talks)) : undefined
          return interrupted(
            taken.map((talk): Piece => (talk.heard === undefined ? { audio: talk.audio } : { audio: talk.audio, heard: talk.heard })),
            from(taken),
          )
        }
        /** How it ends once the microphone has gone and nothing's left to make out: not yet while it's still playing. */
        const deafened = Effect.gen(function* () {
          if (broken !== undefined) return yield* Effect.fail(broken)
          // Stopped for him to speak, and gone deaf before he'd finished, it was never heard to the end, nor what he said.
          if (cut && !completed) return yield* Effect.fail(new AudioError({ message: "The microphone went away while he was talking over it" }))
          return playing ? undefined : ({ _tag: "Finished" } satisfies Outcome)
        })

        while (true) {
          const signal = yield* next
          switch (signal._tag) {
            case "Onset":
              speaking = true
              yield* stopLingering
              // Over what may be its own voice, it carries on just as it was until it's made out that it isn't.
              if (signal.echo) doubt = { at: yield* position, looking: undefined }
              else if (playing) yield* playback.volume(ducked)
              break
            case "Speech":
              yield* stopLingering
              if (playing && doubt === undefined) yield* halt
              break
            case "Partial":
              // One look at a time, while there's still something to stop for him.
              if (doubt === undefined || doubt.looking !== undefined || !playing) break
              doubt.looking = yield* look(signal.audio, doubt.at, true)
              break
            case "Abandoned": {
              speaking = false
              const doubted = doubt !== undefined
              doubt = undefined
              const heard = heardOut()
              if (heard !== undefined) return heard
              if (playing) {
                if (!doubted) yield* playback.volume(1)
              } else if (pending.length === 0) yield* startLingering
              break
            }
            case "Utterance": {
              speaking = false
              const doubted = doubt
              doubt = undefined
              // All of it is made out once he's done, as Whisper hears it whole, whatever a look at some of it found.
              if (doubted !== undefined) {
                pending.push({ id: yield* look(signal.audio, doubted.at), audio: signal.audio, at: doubted.at, whose: undefined, heard: undefined })
                break
              }
              if (pending.length === 0) return interrupted([{ audio: signal.audio }])
              // Said after what's still being made out, it waits for that, so what he said stays in order.
              pending.push({ id: fresh(), audio: signal.audio, at: undefined, whose: "his", heard: undefined })
              const heard = heardOut()
              if (heard !== undefined) return heard
              break
            }
            case "Looked": {
              if (doubt !== undefined && doubt.looking === signal.id) {
                doubt.looking = undefined
                if (signal.whose !== "stop") break
                yield* Effect.logInfo(`Stopping for him: ${signal.heard}`)
                if (playing) yield* halt
                break
              }
              const looked = pending.find((talk) => talk.id === signal.id)
              if (looked === undefined) break
              looked.whose = signal.whose
              looked.heard = signal.taken
              yield* Effect.logInfo(
                signal.whose === "his"
                  ? `Heard: ${signal.heard}`
                  : signal.whose === "stop"
                    ? `Heard him stop it, taking only that: ${signal.taken}, of ${signal.heard}`
                    : `Carried on over what may be its own voice${signal.heard === "" ? "" : `: ${signal.heard}`}`,
              )
              if (signal.whose !== "unclear" && playing) yield* halt
              const heard = heardOut()
              if (heard !== undefined) return heard
              // It was all let go, so it's as if nothing had been said.
              if (pending.length > 0 || playing || speaking) break
              if (deaf) {
                const ending = yield* deafened
                if (ending !== undefined) return ending
              }
              yield* startLingering
              break
            }
            case "Finished":
              // Heard already, as it finished. Also arrives for a playback the user stopped, which is already dealt with.
              if (signal.id !== id || !playing) break
              playing = false
              // What may have been him decides how it ends, once it's made out.
              if (pending.length > 0) break
              if (deaf) return { _tag: "Finished" } satisfies Outcome
              if (!speaking) yield* startLingering
              break
            case "Broke":
              if (signal.id !== id) break
              // Stopped for him to speak, or with what may have been him still being made out, it waits on what he says, unless nothing comes of it.
              if (!playing || pending.length > 0) {
                if (playing) stoppedAt = yield* position
                playing = false
                broken = signal.error
                break
              }
              // As without a microphone: cut short, it wasn't heard, and there's nothing to wait for a reply to.
              return yield* Effect.fail(signal.error)
            case "Lingered":
              if (signal.id !== lingering?.id) break
              if (broken !== undefined) return yield* Effect.fail(broken)
              return { _tag: "Finished" } satisfies Outcome
            case "Deaf": {
              deaf = true
              const heard = heardOut()
              if (heard !== undefined) return heard
              // What may have been him decides how it ends, once it's made out.
              if (pending.length > 0) break
              const ending = yield* deafened
              if (ending !== undefined) return ending
              yield* playback.volume(1)
              break
            }
            case "Replied":
              break
          }
        }
      })

    /**
     * Works out a reply while still listening, so pausing mid-thought doesn't cut
     * the user off: if they carry on before it's ready, it starts again with all
     * they said, and how many seconds of all of it were speech. Nothing's done
     * with a reply while they might still be talking. What they add as the
     * last of yapd's voice is still coming in, just after it stopped, is told
     * apart by what it was saying `last`, as over its first seconds: all of it
     * added when it's clearly theirs, only a stop or wait of theirs, and none
     * when it's unclear.
     */
    const settle = <R>(
      ear: Ear,
      first: string,
      audio: Float32Array,
      transcribe: (audio: Float32Array) => Effect.Effect<string>,
      respond: (heard: string, voiced: number) => Effect.Effect<R>,
      last = "",
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
          let fading = false
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
                fading = signal.fading === true
                break waiting
              case "Deaf":
                speaking = false
                if (carryingOn) break waiting
                if (held !== undefined) return { heard, reply: held }
                break
              case "Finished":
              case "Broke":
              case "Lingered":
              case "Partial":
              case "Looked":
                break
            }
          }
          yield* Fiber.interrupt(fiber)
          if (more === undefined) continue
          const said = yield* transcribe(more)
          // Begun as the last of its voice was still coming in, it may be just that, or some of it.
          const { whose: told, taken: after } = fading ? taking(said, last, false) : { whose: "his", taken: said }
          if (told === "unclear") {
            if (said !== "") yield* Effect.logInfo(`Let go of what may be the last of its own voice: ${said}`)
            continue
          }
          if (told === "stop") yield* Effect.logInfo(`Heard him stop it over the last of its own voice, taking only that: ${after}`)
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
            result === "queued" ? Effect.succeed(lines.queued) : reply.spoken === "" ? persona.onIt() : Effect.succeed(reply.spoken),
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
        yield* Effect.logInfo(`${result === "queued" ? "Queued" : "Sent"}: ${text}`)
        return result
      })

    const transcribe = (audio: Float32Array) =>
      transcriber.transcribe(audio).pipe(
        Effect.catchAll((error) => Effect.logWarning("Could not transcribe", error).pipe(Effect.as(""))),
        Effect.tap((heard) => (heard === "" ? Effect.void : Effect.logInfo(`Heard: ${heard}`))),
      )

    /** What the user said over a line, each piece made out unless it was already, as Whisper heard it, or what's taken of that. */
    const hear = (said: ReadonlyArray<Piece>) =>
      Effect.forEach(said, (piece) => (piece.heard !== undefined ? Effect.succeed(piece.heard) : transcribe(piece.audio))).pipe(
        Effect.map((pieces) => pieces.filter((heard) => heard !== "").reduce((before, after) => (before === "" ? after : together(before, after)), "")),
      )

    /** Takes in what the user said over a line and works out a reply to it, as `settle` does: none when nothing came of what he said. */
    const heardOver = <R>(outcome: Interrupted, respond: (heard: string, voiced: number) => Effect.Effect<R>) =>
      Effect.gen(function* () {
        const first = yield* hear(outcome.said)
        return first === "" ? undefined : yield* settle(outcome.ear, first, outcome.audio, transcribe, respond, outcome.last)
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
            const outcome: Outcome = yield* speak(path, from, missed < misses ? ear : Effect.succeed(undefined), {
              text,
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

            const said = cut(text, outcome.duration > 0 ? outcome.at / outcome.duration : 1)
            const settled = yield* heardOver(outcome, (heard) =>
              responder
                .respond({
                  project: update.project,
                  turn: update.turn,
                  needsYou: update.needsYou,
                  lines: [...lines, { speaker: "yapd", text: said }],
                  heard,
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
            if (settled === undefined) {
              if (after) return
              carryOn()
              continue
            }
            const { heard, reply } = settled
            yield* Effect.logInfo(`Reply: ${reply.intent}${reply.spoken === "" ? "" : `, saying: ${reply.spoken}`}`)
            if (reply.intent !== "resume") {
              yield* journal.write({
                at: yield* Clock.currentTimeMillis,
                kind: "reply",
                host: update.thread.origin.host,
                project: update.project,
                thread: update.session,
                directory: update.thread.cwd,
                said: reply.spoken,
                text: heard,
                detail: { intent: reply.intent, ...(reply.message === "" ? {} : { message: reply.message }) },
              })
              yield* options.replied
            }

            if (reply.intent === "dismiss") return
            if (reply.intent === "resume") {
              if (after) return
              carryOn()
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
     * it was said. `through` runs each time it's said to the end. Returns
     * whether something came of what they said, and fails when it can't be
     * played or breaks off.
     */
    const exchange = (said: Omit<Question, "answer">, respond: Question["answer"], wait: Duration.DurationInput, through: Effect.Effect<void> = Effect.void) =>
      Effect.gen(function* () {
        const ear = hearing(yield* Effect.scope)
        let from = 0
        let missed = 0
        let begun = said.saying ?? Effect.void
        let confirmed = said.confirmed ?? Effect.void
        while (true) {
          const outcome: Outcome = yield* speak(said.audio, from, missed < misses ? ear : Effect.succeed(undefined), {
            text: said.spoken,
            wait,
            begun,
            confirmed,
            through,
          })
          begun = Effect.void
          confirmed = Effect.void
          if (outcome._tag === "Finished") return false
          const settled = yield* heardOver(outcome, respond)
          const reply = settled === undefined ? Option.none() : settled.reply
          if (Option.isSome(reply)) {
            // They've answered or followed it up, so it's taken in even if a dictation starts right now.
            yield* Effect.uninterruptible(reply.value)
            return true
          }
          // Talk that wasn't meant for yapd, once all of it was said, ends it: a question is left unanswered.
          if (outcome.at >= outcome.duration) return false
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
    const answer = (said: Answer) => exchange(said, said.followUp, linger, said.through)

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
