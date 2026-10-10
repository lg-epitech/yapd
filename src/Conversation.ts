import { Clock, Duration, Effect, Fiber, Option, Queue, Scope, Stream } from "effect"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { Audio, AudioError, type Echo, type Playback } from "./Audio.ts"
import type { Turn } from "./Condenser.ts"
import * as Endpointer from "./Endpointer.ts"
import { plain, RelayError, type Thread } from "./Relay.ts"
import { Journal } from "./Journal.ts"
import { Persona } from "./Persona.ts"
import { enough, gist, hallucinated, type Line, type Reply, Responder } from "./Responder.ts"
import type * as Threads from "./Threads.ts"
import { Transcriber } from "./Transcriber.ts"
import { Vad } from "./Vad.ts"
import { clip, extension, Voice } from "./Voice.ts"

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
  | Exclude<Endpointer.Event, { readonly _tag: "Onset" | "Utterance" }>
  /**
   * Might be the user, or with `echo`, yapd's own voice getting into the
   * microphone, as it can until the echo cancellation has learnt it: begun
   * while yapd was `playing` something, as the microphone heard it, after
   * `quiet` frames without a voice, as the voice detector counts them.
   */
  | { readonly _tag: "Onset"; readonly echo: boolean; readonly playing: boolean; readonly quiet: number }
  /** They've finished. */
  | { readonly _tag: "Utterance"; readonly audio: Float32Array }
  /**
   * All the user has said so far of what may be yapd's own voice, passed on
   * as it goes, so a stop of his needn't wait till he's finished: `paused`
   * once he's gone quiet long enough to have finished a word, which is then
   * heard in full, the last too.
   */
  | { readonly _tag: "Partial"; readonly audio: Float32Array; readonly paused?: boolean }
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
   * What Whisper's words for some of what he said over yapd's first seconds
   * come to: the stop of his a look at what he's said so far found, or one it
   * heard only as the last word, `ending`, which the audio may cut through,
   * and what all of it comes to, once he's finished, or as he paused, should
   * he say no more.
   */
  | { readonly _tag: "Looked"; readonly id: number; readonly stop: string | undefined; readonly ending?: string | undefined; readonly whole?: Verdict }
  /**
   * He's been quiet about as long as ends what he says, as the microphone
   * hears it, and none of yapd's voice is still coming in once it stopped:
   * `faded` when some of the last of it did since this was last said, so
   * this is after it.
   */
  | { readonly _tag: "Silent"; readonly faded: boolean }
  /** The microphone never told the last of yapd's voice had stopped coming in, which by now it has. */
  | { readonly _tag: "Lulled"; readonly id: number }

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
      /** How far it got, in seconds: no further than where he began, when it carried on over him until it made out it was him. */
      readonly at: number
      readonly duration: number
      readonly audio: Float32Array
      readonly ear: Ear
      /**
       * What's taken of what he said, when that's known already: only his
       * stop over yapd's first seconds, which is replied to `alone`, or
       * nothing, when yapd stopped for a stop that turned out to be its own
       * words.
       */
      readonly heard?: string
      readonly alone?: true
      /** How many times `cue` has been said for it, when it's what he said once yapd fell quiet for him. */
      readonly cued?: number
    }

type Interrupted = Extract<Outcome, { readonly _tag: "Interrupted" }>

/**
 * How listening over a line went: as `Outcome` has it, or hushed, when what
 * he said over its first seconds was clearly him, so yapd fell quiet for him
 * to say it again, which then stands in for what he said over the line, from
 * `at` seconds into it.
 */
type Listened = Outcome | { readonly _tag: "Hushed"; readonly at: number; readonly duration: number; readonly ear: Ear }

type Hushed = Extract<Listened, { readonly _tag: "Hushed" }>

/** A part of what he says over yapd's first seconds: where it comes in all of that, how far into the line he began it, and its audio. */
interface Part {
  readonly order: number
  readonly at: number
  readonly audio: Float32Array
}

/**
 * All he says from talk he begins while yapd's own voice may still be getting
 * into the microphone, until he and yapd have both been quiet a moment. None
 * of it is ever taken as he said it: it's only told, a part at a time, which
 * can only stop yapd.
 */
interface Chain {
  /** How far into the line he began. */
  readonly at: number
  /**
   * The part he's saying now, while he is: where it comes in what he said,
   * how far into the line he began it, whether he began it once `cue` had
   * been said to the end, the look at it so far under way, for a stop of
   * his, the stop a look found, which yapd stopped for, the one a look heard
   * only as the last word, which all of it is to bear out, and the last look
   * as he paused, how much it had, and what it came to, once it's told.
   */
  part:
    | {
        readonly order: number
        readonly at: number
        readonly after: boolean
        looking: number | undefined
        looked: string | undefined
        ending: string | undefined
        paused: { readonly id: number; readonly samples: number; whole: Verdict | undefined } | undefined
      }
    | undefined
  /** How many parts he's begun. */
  parts: number
  /** Parts he's finished that are still being made out, by the id of the look at all of each, with where each comes, where he began it and its audio. */
  readonly checking: Map<number, Part>
  /**
   * Parts he began once `cue` had been said to the end, `holding` them while
   * nothing he said over it may be him: not made out, as his reply to it,
   * should all he said over it turn out to be only its own voice.
   */
  held: Array<Part>
  holding: boolean
  /** His first stop or wait in it, as he said them, with the part it's in. */
  stop: (Part & { readonly said: string }) | undefined
  /** How far into the line he began the first part that was clearly him, if one was. */
  his: number | undefined
  /** Whether he's been quiet long enough since he last said any of it, with none of yapd's voice still coming in. */
  silent: boolean
  /** Whether yapd fell quiet since, so it's over only once the last of its voice has stopped coming in too, as the microphone tells. */
  lull: boolean
  /** The wait for that, should the microphone never tell, under way. */
  lulling: { readonly id: number; readonly fiber: Fiber.RuntimeFiber<void> } | undefined
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
/**
 * Frames he must have been quiet for what he says over yapd's first seconds
 * to be over, with none of its voice still coming in: about 0.7 s, as long as
 * ends what he says.
 */
const settling = Endpointer.defaults.silence
/**
 * How long after yapd falls quiet the last of its voice is taken to have
 * stopped coming in, should the microphone never tell, as it does within
 * about half a second: long enough that it always does first when it can.
 */
const lulling = "2 seconds"
/** What yapd says once it has fallen quiet for what he said over its first seconds, for him to say it again. */
export const cue = "Sir?"
/** How many times it's said for one interruption, after which he's only listened for. */
const cues = 2
/** Words Whisper writes for `cue` getting into the microphone as it's said, which say nothing of who said them over it. */
const sirs: ReadonlySet<string> = new Set(["sir", "sirs", "sire", "sure", "siri", "sorry", "serve", "stir", "sur", "ser", "cer", "sear", "seer"])
/** What was heard over `cue`, less the words that may be its own voice. */
const unsaid = (heard: string) => heard.replace(/[\p{L}']+/gu, (word) => (sirs.has(word.toLowerCase()) ? "" : word))
/** What comes of a reply to a stop of his over yapd's first seconds that he went on from, which he's to say again. */
const again = "again"
/** What comes of saying `cue` for that, when he said nothing more. */
const unanswered = "unanswered"

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
/**
 * Frames without a voice before what he begins, once `cue` has been said as
 * many times as it's said, or can't be said, for it to be taken as said on
 * its own, rather than as more of what he was saying over yapd: about two
 * seconds, longer than he pauses going on with something.
 */
const breather = Math.round((2 * rate) / frame)
/** Frames of quiet in it after which the last word said is over, so a look at all of it then hears that in full too: a fifth of a second. */
const hush = 6
/**
 * Frames of quiet in it, once yapd's voice can no longer be getting in, that
 * end it, so what he says next, which may begin as its voice stops, is heard
 * on its own, as over the rest of what it says: a quarter of a second.
 */
const lull = 8

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

/**
 * What can only be for yapd to stop or wait, wherever it comes in what he
 * says: as he'd say it on its own, and as it's compared, without single
 * letters, the longest first, so all of "wait a second" is taken.
 */
const halting = [
  ...[...enough, "not now", "wait", "hold on", "hang on", "pause", "one second", "one sec", "just a second", "wait a second", "wait a minute"].map(
    (phrase) => ({ said: `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}.`, words: vocabulary(phrase).filter((word) => word.length > 1) }),
  ),
  // As Whisper may write "never mind".
  { said: "Never mind.", words: ["nevermind"] },
].sort((one, other) => other.words.length - one.words.length)

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
 * "storage", but not one beside a word of its as it is, like the "wait" of
 * "Over in yapd. Wait.", which "yapd" sounds like already.
 */
const halted = (heard: Heard, yapd: ReadonlyArray<string>) => haltAt(heard, yapd)?.said

/** The same, and which of its words it is, from `start` up to `end`. */
const haltAt = ({ words, sentences }: Heard, yapd: ReadonlyArray<string>) => {
  const named = yapd.filter((word) => !common.has(word))
  const its = (at: number) =>
    says(words[at]!, yapd) ||
    [words[at - 1], words[at + 1]].some(
      (beside, side) =>
        beside !== undefined &&
        named.some((spoken) => !alike(beside, spoken) && alike(side === 0 ? `${beside}${words[at]}` : `${words[at]}${beside}`, spoken)),
    )
  for (let start = 0; start < words.length; start++) {
    // Not one he turns around, like the "stop" of "Don't stop the deploy." or the "wait" of "No need to wait.", though "No, wait." is one,
    // and only in the same sentence, so the "stop" of "No, don't. Stop." is one too.
    const before = words.slice(Math.max(0, start - 3), start).filter((_, index, { length }) => sentences[start - length + index] === sentences[start])
    if ((before.length > 0 && before.at(-1) !== "no" && negations.has(before.at(-1)!)) || before.join(" ") === "no need to") continue
    const found = halting.find(
      (phrase) => phrase.words.every((word, index) => words[start + index] === word) && phrase.words.some((_, index) => !its(start + index)),
    )
    if (found !== undefined) return { said: found.said, start, end: start + found.words.length }
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
const wordsOf = (heard: string, yapd: ReadonlyArray<string>) => heardIn(heard, yapd).words

/** The words of what was heard, as `wordsOf` has them, and which sentence each is in, counting from the first. */
interface Heard {
  readonly words: ReadonlyArray<string>
  readonly sentences: ReadonlyArray<number>
}

/** What was heard, as `Heard` has it. */
const heardIn = (heard: string, yapd: ReadonlyArray<string>): Heard => {
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
    .flatMap((sentence, index) => sentence.map((word) => ({ word, sentence: index })))
  // Whisper repeats itself on noise, so a word said again straight after counts once.
  const kept = said.filter(({ word }, index) => word !== said[index - 1]?.word)
  return { words: kept.map(({ word }) => word), sentences: kept.map(({ sentence }) => sentence) }
}

/** What's heard over yapd while its own voice can still get into the microphone comes to: a stop or a wait of his, all his, or unclear, which is let go, as yapd carries on. */
export type Whose = "stop" | "his" | "unclear"

/** Whether a word heard is yapd's word `at`, or "and" for its "in". */
const spokenAt = (word: string, yapd: ReadonlyArray<string>, at: number) =>
  at >= 0 && (stem(word) === stem(yapd[at]!) || (word === "and" && yapd[at] === "in"))

/** Whether two of `words`, one after the other, are two yapd says one after the other, however common, like the "Over and" of "Over and yet.". */
const paired = (words: ReadonlyArray<string>, yapd: ReadonlyArray<string>) =>
  words.some((word, index) => index > 0 && yapd.some((_, at) => spokenAt(word, yapd, at) && spokenAt(words[index - 1]!, yapd, at - 1)))

/**
 * Whether `words` can only be his: no two it says one after another, however
 * common, like the "Over and" of "Over and yet." for "Over in yapd" or the
 * "is this for" of a question of its, none but those nearly anything has in
 * line with what it was saying, its name misheard and all, nor, wherever it
 * comes, like a word of its: a letter or so apart, sounding like it, or the
 * start of it cut off. Nothing but words nearly anything has, they're his
 * only with some it isn't saying, like "Not now." or "Why did it do that?",
 * but not "Over in your".
 */
const clearly = (words: ReadonlyArray<string>, yapd: ReadonlyArray<string>) => {
  if (words.length === 0) return false
  if (paired(words, yapd)) return false
  if (words.every((word) => common.has(word))) return words.some((word) => !yapd.some((_, at) => spokenAt(word, yapd, at)))
  const its = ours(words, yapd)
  return words.every((word, index) => common.has(word) || !(its.has(index) || yapd.some((spoken) => alike(word, spoken))))
}

/**
 * Whose voice was heard over a line yapd was `saying`, before the echo
 * cancellation had learnt its voice, going by Whisper's words, which this
 * only ever tells by, never changes. His, when it clearly is, as `clearly`
 * has it, and more than what Whisper makes up, like "That's it.". Otherwise a
 * stop: a "stop" or "wait" he said that isn't a word of its, though some of
 * the rest may be its voice. Anything else is unclear, its own voice or what
 * may be.
 */
export const whose = (heard: string, saying: string): Whose => {
  const yapd = vocabulary(saying)
  const told = heardIn(heard, yapd)
  if (clearly(told.words, yapd)) return "his"
  return halted(told, yapd) === undefined ? "unclear" : "stop"
}

/** The stop or wait of his in what was heard over a line yapd was `saying`, as he'd say it on its own: none when there's none. */
export const stopIn = (heard: string, saying: string) => {
  const yapd = vocabulary(saying)
  return halted(heardIn(heard, yapd), yapd)
}

/**
 * Whether Whisper, hearing all of what was said over a line yapd was
 * `saying`, heard the words of a `stop` a look at some of it took for his as
 * something like them it took for its own, like its "step" for "stop", rather
 * than leave them out, as it can a short word over its voice. Only by its
 * words not just anything has, like the "hold" of "hold on", never the "on"
 * of its "working on", nor anything of "not now".
 */
const mistaken = (stop: string, heard: string, saying: string) => {
  const stopping = vocabulary(stop).filter((word) => !common.has(word))
  return wordsOf(heard, vocabulary(saying)).some((word) => stopping.some((said) => alike(word, said) || alike(said, word)))
}

/**
 * What some of what he said over yapd's first seconds comes to: his stop or
 * wait, as he'd say it on its own, him, as `whose` has it, or unclear, and
 * `unheard` when that's as Whisper heard nothing at all in it, or failed.
 */
type Verdict =
  | { readonly whose: "stop"; readonly stop: string }
  | { readonly whose: "his" }
  | { readonly whose: "unclear"; readonly unheard?: true }

/**
 * Whether Whisper, hearing all of what was said over a line yapd was
 * `saying`, heard a word the last word of a `stop` may have been the start of,
 * cut through by a look at some of it, like its "storage" for "stop": any
 * word starting as that does.
 */
const cutThrough = (stop: string, heard: string, saying: string) => {
  const last = vocabulary(stop).at(-1)
  return last !== undefined && wordsOf(heard, vocabulary(saying)).some((word) => word.startsWith(last.slice(0, 2)))
}

/**
 * What all of something said over a line yapd was `saying`, before the echo
 * cancellation had learnt its voice, comes to: a stop or wait of his,
 * wherever it comes, or else the one a look at some of it found, `looked`,
 * unless Whisper hearing all of it took that for words of yapd's, or the one
 * a look heard only as the last word, `ending`, unless Whisper hearing all of
 * it heard nothing, or took that for words of yapd's, or for the start of one;
 * else him, when it's clearly him; else unclear.
 */
const judge = (heard: string, saying: string, looked?: string, ending?: string): Verdict => {
  const stop =
    stopIn(heard, saying) ??
    (looked === undefined || mistaken(looked, heard, saying) ? undefined : looked) ??
    (ending === undefined || heard.trim() === "" || mistaken(ending, heard, saying) || cutThrough(ending, heard, saying) ? undefined : ending)
  if (stop !== undefined) return { whose: "stop", stop }
  return whose(heard, saying) === "his" ? { whose: "his" } : { whose: "unclear" }
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

/** How a line is said and listened over, as `speak` has it. */
interface Playing {
  readonly text?: string
  /** Whether it's `cue`, over which all he begins is told as over yapd's first seconds, however long it has talked. */
  readonly cue?: boolean
  readonly wait?: Duration.DurationInput
  readonly begun?: Effect.Effect<void>
  readonly confirmed?: Effect.Effect<void>
  readonly through?: Effect.Effect<void>
}

/** Nothing playing, to listen over as once a line has been said to the end. */
const nothing: Playback = { duration: 0, confirmed: true, finished: Effect.void, stop: Effect.succeed(0), volume: () => Effect.void }

/**
 * Reads updates out while listening. Talking over yapd ducks it at once and
 * stops it once it's clearly speech; what the user said then, word for word,
 * decides whether it stops there, answers, sends the agent a follow-up, or
 * carries on. All he says from talk he begins while its own voice can still
 * get into the microphone, until he and yapd have both been quiet a moment,
 * is never taken as he said it: a stop or wait of his stops it, and is all
 * that's replied to; what's clearly him makes it fall quiet and say "Sir?",
 * and what he says again then is taken whole; anything else is let go, as it
 * carries on.
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
        /** Whether what's being said began while yapd's own voice could still get into the microphone. */
        let unsure = false
        /** Frames of that since all of it was last passed on, once it's speech. */
        let since: number | undefined
        /** Whether yapd's own voice has stopped getting in since that began: past its first seconds, or once it stopped talking. */
        let past = false
        const reset = () => {
          unsure = false
          since = undefined
          past = false
        }
        /**
         * Frames he's been quiet for, counted as the voice detector counts
         * them, whether that's long enough with none of yapd's voice still
         * coming in once it stopped, as `settling` has it, and whether the last
         * of its voice came in since that was last passed on. Told by the
         * frames as they come, never the clock, so however far behind this
         * runs, what he says before then is never taken for after.
         */
        let still = 0
        let calm = false
        let faded = false
        const quieted = (echo: Echo | undefined, probability: number): Signal | undefined => {
          const { on, off } = Endpointer.defaults
          still = probability >= on ? 0 : probability < off || still > 0 ? still + 1 : still
          if (echo === "fading") faded = true
          const settled = still >= settling && echo !== "fading"
          const silent = settled && !calm ? ({ _tag: "Silent", faded } satisfies Signal) : undefined
          calm = settled
          if (silent !== undefined) faded = false
          return silent
        }
        /** What's told of what's said, as of a frame. */
        const signalled = (echo: Echo | undefined, event: Endpointer.Event | undefined): Signal | undefined => {
          if (event === undefined) {
            if (since === undefined) return undefined
            // Once as he pauses, when all he said so far is over, and about a second at a time while he talks.
            if (endpointer.pausing) {
              if (past && endpointer.silent >= lull) {
                const audio = endpointer.end()
                reset()
                return audio === undefined ? undefined : { _tag: "Utterance", audio }
              }
              if (endpointer.silent !== hush) return undefined
              since = 0
              return { _tag: "Partial", audio: endpointer.soFar(), paused: true }
            }
            if (++since < glance) return undefined
            since = 0
            return { _tag: "Partial", audio: endpointer.soFar() }
          }
          switch (event._tag) {
            case "Onset":
              // As it starts, since by the time it's made out, yapd may well have learnt its own voice. Only
              // while it talks: what begins as it stops is far likelier him answering than the last of its voice.
              unsure = echo === "talking"
              return { _tag: "Onset", echo: unsure, playing: unsure || echo === "playing", quiet: still }
            case "Speech":
              since = unsure ? 0 : undefined
              return event
            case "Utterance":
            case "Abandoned":
              reset()
              return event
          }
        }
        yield* Stream.fromQueue(microphone.value).pipe(
          Stream.mapEffect((frame) =>
            Effect.gen(function* () {
              const echo = yield* audio.echo(frame)
              if (unsure && echo !== "talking") past = true
              const probability = yield* detect.value(frame)
              const event = endpointer.push(frame, probability)
              return [signalled(echo, event), quieted(echo, probability)].filter((signal) => signal !== undefined)
            }),
          ),
          Stream.runForEach((signals) => Queue.offerAll(ear.signals, signals)),
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
     * they say after. Should it fall quiet for him to say again what he said
     * over its first seconds, what he says then is what he said over it.
     */
    const speak = (path: string, from: number, ear: Effect.Effect<Ear | undefined>, given: Playing = {}) =>
      Effect.flatMap(play(path, from, ear, given), (listened) =>
        listened._tag === "Hushed" ? pardon(listened, given.wait ?? linger) : Effect.succeed(listened),
      )

    /** Plays a line and listens over it, as `speak` does, leaving what's to be done once it has fallen quiet for him to whoever asked. */
    const play = (path: string, from: number, ear: Effect.Effect<Ear | undefined>, given: Playing = {}) =>
      Effect.gen(function* () {
        const { text = "", cue = false, wait = linger, begun = Effect.void, confirmed = Effect.void, through = Effect.void } = given
        const playback = yield* audio.play(path, from)
        yield* begun
        if (playback.confirmed) yield* confirmed
        // Otherwise it's known only as it plays to the end, so it goes with what runs then, holding nothing up meanwhile.
        const played = playback.confirmed ? through : Effect.zipRight(confirmed, through)
        const listening = yield* ear
        if (listening === undefined || listening.deaf) {
          yield* playback.finished
          yield* played
          return { _tag: "Finished" } satisfies Listened
        }
        return yield* listen(playback, listening, { text, from, cue }, wait, played)
      }).pipe(Effect.scoped)

    /**
     * Once yapd has fallen quiet for what he said over its first seconds,
     * `hushed`, says `cue` for him to say it again, and listens over it and
     * `wait` after, as over a line, for his reply to the line he talked over,
     * which what he says then stands in for. What he says over it may be its
     * own voice too, so it's told the same way: should that make it fall
     * quiet again, it's said once more, and after that he's only listened
     * for, counting the times it was said already, `cued`, taking only what
     * he begins after a pause longer than he makes going on with something,
     * for only `wait` from once it won't be said again, however much he says
     * meanwhile, like a TV that never pauses that long. Saying
     * nothing more, or once the microphone has gone, he's finished with it,
     * as with a line nothing was said back to.
     */
    const pardon = (hushed: Hushed, wait: Duration.DurationInput, cued = 0) =>
      Effect.gen(function* () {
        /** When he's no longer listened for, once "Sir?" has been said as often as it is. */
        let until: number | undefined
        for (let said = cued; ; said++) {
          if (hushed.ear.deaf) return { _tag: "Finished" } satisfies Outcome
          if (said >= cues) until ??= (yield* Clock.currentTimeMillis) + Duration.toMillis(wait)
          const listened: Listened = yield* until === undefined ? asking(hushed.ear, wait) : quietly(hushed.ear, wait, until)
          if (listened._tag === "Hushed") continue
          return listened._tag === "Finished"
            ? listened
            : ({ ...listened, at: hushed.at, duration: hushed.duration, cued: Math.min(said + 1, cues) } satisfies Outcome)
        }
      })

    /** Says `cue` and listens over it and `wait` after, as over any line: only listens, when it can't be rendered. */
    const asking = (ear: Ear, wait: Duration.DurationInput) =>
      Effect.gen(function* () {
        const path = join(options.dir, `${crypto.randomUUID()}${extension}`)
        yield* Effect.addFinalizer(() => Effect.promise(() => rm(path, { force: true })))
        const rendered = yield* voice.render(cue, path).pipe(
          // Played only as long as its voice lasts, so what he begins once that's over, to him after it, is heard as after it.
          Effect.zipRight(clip(path)),
          Effect.as(true),
          Effect.catchAll((error) => Effect.logWarning(`Could not say "${cue}"`, error).pipe(Effect.as(false))),
        )
        return yield* rendered ? play(path, 0, Effect.succeed(ear), { text: cue, cue: true, wait }) : quietly(ear, wait)
      }).pipe(Effect.scoped)

    /**
     * Listens for `wait`, as once a line has been said to the end, in place of
     * `cue`, or only `until` then, by the clock, when that's given. What he
     * begins before he's been quiet for a `breather` may be more of what he
     * was saying over yapd, with no "Sir?" between to have him say it all
     * again, so it's told as what he says over its first seconds.
     */
    const quietly = (ear: Ear, wait: Duration.DurationInput, until?: number) =>
      ear.deaf
        ? Effect.succeed<Listened>({ _tag: "Finished" })
        : listen(nothing, ear, { text: "", from: 0, cue: false, breather, until }, wait, Effect.void).pipe(Effect.scoped)

    /**
     * Listens over a line, `text` played from `from` seconds, and stops it as
     * soon as the user talks over it. Talk he begins while yapd's own voice
     * can still get into the microphone may be just that, and talk he begins
     * over `cue` the rest of what he said before it, so all he says from then
     * until he and yapd have both been quiet a moment, a `Chain`, is never
     * taken as he said it. It carries on just as it was over that, and
     * makes out each part he finishes, one at a time: a stop or wait of his,
     * heard in full too while he goes on, stops it, and is all that's taken,
     * to be replied to alone; what's clearly him makes it fall quiet,
     * `Hushed`, for him to say it again; and anything else is let go.
     */
    const listen = (
      playback: Playback,
      ear: Ear,
      line: { readonly text: string; readonly from: number; readonly cue: boolean; readonly breather?: number; readonly until?: number | undefined },
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
        /** All he's said since he began talking over its first seconds, until that's over. */
        let chain: Chain | undefined
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
          // Never longer than `until`, however often he's begun and finished since.
          const lasting = line.until === undefined ? wait : Duration.millis(Math.max(0, line.until - (yield* Clock.currentTimeMillis)))
          const fiber = yield* Effect.sleep(lasting).pipe(
            Effect.zipRight(Queue.offer(signals, { _tag: "Lingered", id })),
            Effect.asVoid,
            Effect.forkScoped,
          )
          lingering = { id, fiber }
        })
        const stopLulling = Effect.suspend(() => {
          const fiber = chain?.lulling?.fiber
          if (chain !== undefined) chain.lulling = undefined
          return fiber === undefined ? Effect.void : Fiber.interrupt(fiber)
        })
        /** Waits `lulling` for the last of its voice to stop coming in, should the microphone not tell before, while he's quiet. */
        const startLulling = Effect.gen(function* () {
          yield* stopLulling
          if (chain === undefined || !chain.lull || speaking) return
          const id = fresh()
          const fiber = yield* Effect.sleep(lulling).pipe(
            Effect.zipRight(Queue.offer(signals, { _tag: "Lulled", id })),
            Effect.asVoid,
            Effect.forkScoped,
          )
          chain.lulling = { id, fiber }
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
        /** How far it got for talk he began `at` seconds in: no further than there, as it carried on over him until it made out it was him. */
        const reached = (at: number) => (completed ? playback.duration : Math.min(stoppedAt ?? playback.duration, at))
        /** Notes that yapd fell quiet while he talked over its first seconds, which is over only once the last of its voice has stopped coming in. */
        const fellQuiet = Effect.gen(function* () {
          if (chain === undefined) return
          chain.silent = false
          chain.lull = true
          yield* startLulling
        })
        /** Stops yapd for him to speak. */
        const halt = Effect.gen(function* () {
          playing = false
          cut = true
          stoppedAt = yield* playback.stop
          yield* fellQuiet
        })
        /**
         * Makes out some of what he said over the line from `at` seconds in,
         * by what yapd was saying around it, without holding up playing or
         * listening, and passes on what it comes to with the id it returns: of
         * what he's said `soFar`, only a stop of his heard in full before the
         * last word, which the audio may cut through; once he's `paused`, his
         * stop in all of it, and what all of it comes to, should he say no
         * more; and once he's finished, what all of it comes to, `whole`, with
         * the stop a look at some of it found, `looked`, or heard only as the
         * last word, `ending`.
         */
        const look = (audio: Float32Array, at: number, how: "soFar" | "paused" | "whole", looked?: string, ending?: string) =>
          Effect.gen(function* () {
            const id = fresh()
            const saying = between(line.text, playback.duration, at - reach, (yield* position) + reach)
            yield* transcriber.transcribe(audio).pipe(
              Effect.catchAll((error) => Effect.logWarning("Could not transcribe", error).pipe(Effect.as(""))),
              whisper.withPermits(1),
              Effect.flatMap((heard) => {
                // Over "Sir?", what's like it is its own voice, so it's told by the rest.
                const told = line.cue ? unsaid(heard) : heard
                const whole = judge(told, saying, looked, ending)
                const stop = how === "whole" ? undefined : stopIn(how === "soFar" ? cutShort(told) : told, saying)
                return Queue.offer(signals, {
                  _tag: "Looked",
                  id,
                  stop,
                  ...(how === "soFar" && stop === undefined ? { ending: stopIn(told, saying) } : {}),
                  ...(how === "soFar" ? {} : { whole: whole.whose === "unclear" && heard.trim() === "" ? { whose: "unclear", unheard: true } : whole }),
                })
              }),
              Effect.forkScoped,
            )
            return id
          })
        /** Once some of what he said over "Sir?" may be him, makes out what he began after it with that, for a stop, as it may go on from it. */
        const unhold = Effect.gen(function* () {
          if (chain === undefined) return
          chain.holding = false
          for (const reply of chain.held.splice(0)) chain.checking.set(yield* look(reply.audio, chain.at, "whole"), reply)
        })
        /** Takes in what a part of what he said over its first seconds comes to: his stop, or him, clearly, stops yapd, and anything else is let go. */
        const told = (verdict: Verdict, part: Part) =>
          Effect.gen(function* () {
            if (chain === undefined) return
            // Logged without his words, which are never taken, so none of them can be kept anywhere.
            if (verdict.whose === "unclear") {
              if (verdict.unheard === true) yield* unhold
              return yield* Effect.logInfo("Carried on over what may be its own voice")
            }
            if (verdict.whose === "stop") {
              if (chain.stop === undefined || part.order < chain.stop.order) chain.stop = { ...part, said: verdict.stop }
              // Nothing else he said counts, what he began once "Sir?" was over too.
              chain.held = []
              yield* Effect.logInfo(`Heard him stop it over its first seconds, taking only that: ${verdict.stop}`)
            } else {
              chain.his = Math.min(chain.his ?? part.at, part.at)
              yield* unhold
              yield* Effect.logInfo("Heard him over its first seconds, so it falls quiet for him to say it again")
            }
            if (playing) yield* halt
          })
        /** How it ends once the microphone has gone and nothing's left to make out: not yet while it's still playing. */
        const deafened = Effect.gen(function* () {
          if (broken !== undefined) return yield* Effect.fail(broken)
          // Stopped for him to speak, and gone deaf before he'd finished, it was never heard to the end, nor what he said.
          if (cut && !completed) return yield* Effect.fail(new AudioError({ message: "The microphone went away while he was talking over it" }))
          return playing ? undefined : ({ _tag: "Finished" } satisfies Listened)
        })
        /**
         * Ends what he said over its first seconds once he's been quiet long
         * enough, with none of yapd's voice still coming in, or he can't be
         * heard anymore, and none of it is still being made out: with his stop,
         * replied to alone; hushed, for him to say again what was clearly him;
         * or all of it let go, as if nothing had been said, picking up from
         * before he began should yapd have stopped for a stop that turned out
         * to be its own words. None until then, nor when it just carries on.
         * Over "Sir?", once all he said over it has turned out to be its own
         * voice, what he began after it is his reply to it, taken whole as
         * soon as he's finished.
         */
        const close = Effect.gen(function* () {
          if (chain === undefined || speaking || chain.checking.size > 0) return undefined
          // All he said over "Sir?" was only its own voice, so what he began once it was said to the end is his reply to it, taken whole.
          if (chain.held.length > 0 && chain.holding && chain.stop === undefined) {
            const audio = Endpointer.concat(chain.held.map((part) => part.audio))
            yield* stopLulling
            chain = undefined
            return { _tag: "Interrupted", at: playback.duration, duration: playback.duration, audio, ear } satisfies Listened
          }
          if (!(chain.silent || deaf)) return undefined
          const { at, stop, his } = chain
          yield* stopLulling
          chain = undefined
          const duration = playback.duration
          if (stop !== undefined) {
            return { _tag: "Interrupted", at: reached(stop.at), duration, audio: stop.audio, ear, heard: stop.said, alone: true } satisfies Listened
          }
          if (his !== undefined) {
            if (broken !== undefined) return yield* Effect.fail(broken)
            if (deaf) return yield* deafened
            return { _tag: "Hushed", at: reached(his), duration, ear } satisfies Listened
          }
          if (cut && !completed) return { _tag: "Interrupted", at: reached(at), duration, audio: new Float32Array(), ear, heard: "" } satisfies Listened
          if (deaf) return yield* deafened
          if (!playing) yield* startLingering
          return undefined
        })

        while (true) {
          const signal = yield* next
          switch (signal._tag) {
            case "Onset":
              speaking = true
              yield* stopLingering
              // Begun over what may be its own voice, it carries on just as it was, as over all he says until he and yapd have both
              // been quiet a moment, which is only ever told, a part at a time, and never taken as he said it. Over "Sir?", that's
              // all he begins before it has been said to the end, as he may be going on with what he said before it, even when
              // it's said after its first seconds, or he began while it was still being rendered, or as it ended, though that's
              // only made out once it has. Listening in its place, that's all he begins before he's paused for a breather.
              if (chain === undefined && (signal.echo || (line.cue && (playing || signal.playing)) || signal.quiet < (line.breather ?? 0))) {
                chain = {
                  at: yield* position,
                  part: undefined,
                  parts: 0,
                  checking: new Map(),
                  held: [],
                  holding: true,
                  stop: undefined,
                  his: undefined,
                  silent: false,
                  lull: false,
                  lulling: undefined,
                }
              }
              if (chain === undefined) {
                if (playing) yield* playback.volume(ducked)
                break
              }
              yield* stopLulling
              chain.silent = false
              chain.part = {
                order: ++chain.parts,
                at: yield* position,
                after: line.cue && completed && !playing && !signal.playing,
                looking: undefined,
                looked: undefined,
                ending: undefined,
                paused: undefined,
              }
              break
            case "Speech":
              yield* stopLingering
              if (playing && chain === undefined) yield* halt
              break
            case "Partial":
              // One look at a time, while there's still something to stop for him.
              if (chain?.part === undefined || chain.part.looking !== undefined || !playing) break
              chain.part.looking = yield* look(signal.audio, chain.at, signal.paused === true ? "paused" : "soFar", chain.part.looked, chain.part.ending)
              chain.part.paused = signal.paused === true ? { id: chain.part.looking, samples: signal.audio.length, whole: undefined } : undefined
              break
            case "Abandoned": {
              speaking = false
              if (chain === undefined) {
                if (playing) yield* playback.volume(1)
                else yield* startLingering
                break
              }
              chain.part = undefined
              yield* startLulling
              const closed = yield* close
              if (closed !== undefined) return closed
              break
            }
            case "Utterance": {
              speaking = false
              if (chain === undefined) {
                return { _tag: "Interrupted", at: stoppedAt ?? playback.duration, duration: playback.duration, audio: signal.audio, ear } satisfies Listened
              }
              const { part } = chain
              chain.part = undefined
              yield* startLulling
              // Once a stop of his is known, nothing else he said counts.
              if (part !== undefined && chain.stop === undefined) {
                // Said nothing more since he paused, the look then has all of it, and is told as that, once it's back.
                const paused = part.paused !== undefined && signal.audio.length <= part.paused.samples ? part.paused : undefined
                const finished = { order: part.order, at: part.at, audio: signal.audio }
                // Begun once "Sir?" was over, with nothing over it known to be him, it's held for his reply until that's known.
                if (part.after && chain.holding) chain.held.push(finished)
                else if (paused?.whole !== undefined) yield* told(paused.whole, finished)
                else chain.checking.set(paused?.id ?? (yield* look(signal.audio, chain.at, "whole", part.looked, part.ending)), finished)
              }
              const closed = yield* close
              if (closed !== undefined) return closed
              break
            }
            case "Looked": {
              if (chain === undefined) break
              const { part } = chain
              if (part?.looking === signal.id) {
                part.looking = undefined
                if (part.paused?.id === signal.id) part.paused.whole = signal.whole
                // Heard only as the last word, it's not stopped for, but kept for all of it to bear out.
                part.ending ??= signal.ending
                if (signal.stop === undefined) break
                yield* Effect.logInfo(`Stopping for him over its first seconds: ${signal.stop}`)
                part.looked ??= signal.stop
                if (playing) yield* halt
                break
              }
              const checked = chain.checking.get(signal.id)
              if (checked === undefined || signal.whole === undefined) break
              chain.checking.delete(signal.id)
              yield* told(signal.whole, checked)
              const closed = yield* close
              if (closed !== undefined) return closed
              break
            }
            case "Silent": {
              // After yapd fell quiet, only once the last of its voice has stopped coming in.
              if (chain === undefined || (chain.lull && !signal.faded)) break
              yield* stopLulling
              chain.lull = false
              chain.silent = true
              const closed = yield* close
              if (closed !== undefined) return closed
              break
            }
            case "Lulled": {
              if (chain?.lulling?.id !== signal.id) break
              chain.lulling = undefined
              chain.lull = false
              chain.silent = true
              const closed = yield* close
              if (closed !== undefined) return closed
              break
            }
            case "Finished": {
              // Heard already, as it finished. Also arrives for a playback the user stopped, which is already dealt with.
              if (signal.id !== id || !playing) break
              playing = false
              // What he says over its first seconds decides how it ends, once that's over.
              if (chain !== undefined) {
                yield* fellQuiet
                break
              }
              if (deaf) return { _tag: "Finished" } satisfies Listened
              if (!speaking) yield* startLingering
              break
            }
            case "Broke": {
              if (signal.id !== id) break
              // Stopped for him to speak, or with what he says over its first seconds still going, it waits on what he says, unless nothing comes of it.
              if (!playing || chain !== undefined) {
                if (playing) {
                  stoppedAt = yield* position
                  playing = false
                  yield* fellQuiet
                }
                broken = signal.error
                break
              }
              // As without a microphone: cut short, it wasn't heard, and there's nothing to wait for a reply to.
              return yield* Effect.fail(signal.error)
            }
            case "Lingered":
              if (signal.id !== lingering?.id) break
              if (broken !== undefined) return yield* Effect.fail(broken)
              return { _tag: "Finished" } satisfies Listened
            case "Deaf": {
              deaf = true
              // Nothing more of what he says over its first seconds can be heard, so it's over once what was is made out.
              if (chain !== undefined) {
                speaking = false
                chain.part = undefined
                const closed = yield* close
                if (closed !== undefined) return closed
                break
              }
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
     * with a reply while they might still be talking. Their stop from over
     * yapd's first seconds is replied to `alone`, since nothing they said
     * around it is taken: nothing they say before the reply is added to it.
     * Should they go on before then, what they say may be the rest of what
     * they said over those seconds, so none of it is taken, and nor is their
     * stop, which what they go on with takes the place of, as it does after
     * a stop anywhere else: it comes to `again`, for them to say it again.
     */
    const settle = <R>(
      ear: Ear,
      first: string,
      audio: Float32Array,
      transcribe: (audio: Float32Array) => Effect.Effect<string>,
      respond: (heard: string, voiced: number) => Effect.Effect<R>,
      alone = false,
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
          /** Gone on from a stop replied to alone, so they're to say it again. */
          let goneOn = false
          let held: R | undefined
          let more: Float32Array | undefined
          waiting: while (true) {
            const signal = yield* (speaking || carryingOn || goneOn)
              ? Queue.take(ear.signals).pipe(
                  Effect.timeout(patience),
                  Effect.orElseSucceed((): Signal => ({ _tag: "Deaf" })),
                )
              : Queue.take(ear.signals)
            switch (signal._tag) {
              case "Replied":
                // Once they carry on, even one that got in before it was stopped is out of date.
                if (signal.id !== id || carryingOn || goneOn) break
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
                if (alone) {
                  goneOn = true
                  held = undefined
                  yield* Fiber.interrupt(fiber)
                  break
                }
                carryingOn = true
                held = undefined
                yield* Fiber.interrupt(fiber)
                break
              case "Utterance":
                // Asked for again, once they've finished it.
                if (alone) {
                  speaking = false
                  if (goneOn) return again
                  if (held !== undefined) return { heard, reply: held }
                  break
                }
                more = signal.audio
                break waiting
              case "Deaf":
                speaking = false
                if (goneOn) return again
                if (carryingOn) break waiting
                if (held !== undefined) return { heard, reply: held }
                break
              case "Finished":
              case "Broke":
              case "Lingered":
              case "Partial":
              case "Looked":
              case "Silent":
              case "Lulled":
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
     * Takes in what the user said over a line, made out with `transcribe`
     * unless what's taken of it is known already, and works out a reply to
     * it, as `settle` does: none when nothing came of what he said. Should he
     * go on from his stop over its first seconds before it's replied to, it
     * says `cue` for him to say it all again, listening `wait` after, and
     * takes what he says then in its place: `unanswered` when that's nothing.
     */
    const heardOver = <R>(
      outcome: Interrupted,
      wait: Duration.DurationInput,
      transcribe: (audio: Float32Array) => Effect.Effect<string>,
      respond: (heard: string, voiced: number) => Effect.Effect<R>,
    ) =>
      Effect.gen(function* () {
        let interrupted = outcome
        while (true) {
          const first = interrupted.heard ?? (yield* transcribe(interrupted.audio))
          if (first === "") return undefined
          const settled = yield* settle(interrupted.ear, first, interrupted.audio, transcribe, respond, interrupted.alone === true)
          if (settled !== again) return settled
          const { at, duration, ear, cued } = interrupted
          const asked = yield* pardon({ _tag: "Hushed", at, duration, ear }, wait, cued)
          if (asked._tag === "Finished") return unanswered
          interrupted = asked
        }
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
            const settled = yield* heardOver(outcome, linger, unlogged, (heard) =>
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
            // Asked to say it again, he said nothing more.
            if (settled === unanswered) return
            if (settled === undefined) {
              if (after) return
              carryOn()
              continue
            }
            const { heard, reply } = settled
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
     * it was said. Its `through` runs each time it's said to the end, and
     * what they say is heard listening for its `terms`. Returns whether
     * something came of what they said, and fails when it can't be played or
     * breaks off.
     */
    const exchange = (said: Omit<Question, "answer">, respond: Question["answer"], wait: Duration.DurationInput) =>
      Effect.gen(function* () {
        const ear = hearing(yield* Effect.scope)
        // Listening for its options, if it has any, all of what he says back, however long he goes on.
        const makeOut = (audio: Float32Array) => transcribe(audio, said.terms)
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
            through: said.through ?? Effect.void,
          })
          begun = Effect.void
          confirmed = Effect.void
          if (outcome._tag === "Finished") return false
          const settled = yield* heardOver(outcome, wait, makeOut, respond)
          // Asked to say it again, he said nothing more, which leaves a question unanswered.
          if (settled === unanswered) return false
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
