// What he says, as code compares it, and the words it knows without asking a
// model. Nothing of yapd's is imported here, so whatever reads what he says,
// the Responder, the Brain or a question, can share it without importing the
// others, which import each other.

/** A line of a conversation, as a model is shown it. */
export interface Line {
  readonly speaker: "yapd" | "user"
  readonly text: string
  /** For the user, what yapd was saying around when they began, when its own voice could still get into their microphone. */
  readonly echo?: string
  /** With `echo`, what they said once they carried on after a pause, which is surely theirs. */
  readonly afterPause?: string
  /** With `echo`, the routines whose steps the line it came from holds, as code put them in: a model is only ever told of it by their names. */
  readonly echoRoutines?: ReadonlyArray<string>
  /** For yapd, the routines whose steps its line holds, as code put them in: a model is only ever told of it by their names. */
  readonly routines?: ReadonlyArray<string>
}

/** What only fills a pause or asks nicely, which is never what was said. */
export const padding = ["uh", "um", "erm", "oh", "ah", "hmm", "sir", "please"]

/** What he calls yapd, which is only how he addresses it, unless it's all he said. */
export const names = ["jarvis", "yapd"]

/**
 * What's said, as it's compared: lowercase words, without the "um", "sir" and
 * "Jarvis" around them. A name said on its own is kept, since "Yapd." can be
 * the answer to which project, and is never silence.
 */
export const gist = (heard: string) => {
  const words = heard
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .split(/\s+/)
    .filter((word) => word !== "" && !padding.includes(word))
  const said = words.filter((word) => !names.includes(word))
  return (said.length > 0 ? said : words).join(" ")
}

/** What's said, as it's compared, each word once, so what Whisper heard again and again, like "Stop, stop.", is as if said once. */
export const once = (heard: string) => [...new Set(gist(heard).split(" "))].join(" ")

/** Hearing enough, however it's put. Said to any update, it never goes to the agent. */
export const enough: ReadonlySet<string> = new Set([
  "stop", "quiet", "be quiet", "shut up", "silence", "mute", "skip", "skip it", "next", "enough", "that's enough", "never mind",
])

/** Calling it off, said on its own to an update: hearing enough of it, never something for yapd to forget, which is asked with the shortcut. */
export const callingOff: ReadonlySet<string> = new Set(["forget it", "forget about it"])

/** What Whisper writes for near-silence, which nobody said. */
export const hallucinated: ReadonlySet<string> = new Set(["you", "thank you", "bye", "see you again", "kid", "thanks for watching"])

/** Taking an update in. Said to one that asked something, they could be the answer, so the model judges those. */
export const noted: ReadonlySet<string> = new Set([
  "thanks", "thank you", "thanks a lot", "cheers", "got it", "ok", "okay", "ok thanks", "okay thanks", "cool", "great", "good",
  "very good", "perfect", "nice", "sounds good", "alright", "all right", "noted", "understood", "awesome", "fine", "good job",
  "well done", "excellent", "brilliant", "lovely", "good to know", "ok cool", "okay cool", "great thanks", "perfect thanks",
])

/** Asking for the rest of an update yapd said only the headline of. */
export const morePlease: ReadonlySet<string> = new Set(["more", "tell me more", "more please", "details", "more details", "what else", "the details"])

/** Going ahead with what was asked. Only ever taken as that after a question. */
export const agreed: ReadonlySet<string> = new Set([
  "yes", "yeah", "yep", "yup", "sure", "go ahead", "do it", "yes do it", "yes go ahead", "go for it", "yes go for it",
  "absolutely", "of course", "yes of course", "yeah do it", "yeah go ahead", "sure go ahead", "ok do it", "okay do it",
  "ok go ahead", "okay go ahead", "yes yes", "yeah yeah", "sounds good do it", "sounds good go ahead", "yes that's fine",
  "yes it's fine", "yes ship it", "ship it", "merge it", "yes merge it", "go on", "proceed", "yes proceed", "do both",
  "yes do both", "yes both", "both",
])

/** Asking to hear what was just said again. */
export const again: ReadonlySet<string> = new Set([
  "say again", "say that again", "say it again", "repeat", "repeat that", "repeat it", "what", "pardon", "come again",
  "sorry what", "what was that", "can you repeat that", "could you repeat that",
])

/**
 * Of `again`, what can only ask to hear it again, never answer a question,
 * like "Shall I repeat the migration?", which "repeat it" may.
 */
export const pardon: ReadonlySet<string> = new Set(["say that again", "say it again", "say again", "come again", "pardon", "what was that", "sorry what"])

/** Whether a line ends asking something, whatever quotes or brackets close it. */
export const question = /\?\s*["')\]]*\s*$/

/**
 * "Mute." on its own, however many times Whisper heard it: his emergency off,
 * which turns yapd off at once wherever he says it, as the menu does, with
 * nothing worked out of it. Never "mute it" or "mute the Tezos one", which
 * mute a thread, nor "Mute?", which asks something: that's the model's to
 * make sense of.
 */
export const halts = (heard: string) => !question.test(heard) && once(heard) === "mute"

/** Turning yapd back on, in so many words, which only said by the shortcut while it's off turns it on: on, "unmute" is about a thread. */
const turningOn: ReadonlySet<string> = new Set(["unmute", "un mute", "turn on", "turn it on", "turn yourself on", "turn back on"])

/** Whether what he said is only to turn yapd back on: never asked, like "Unmute?", which is the model's to make sense of. */
export const wakes = (heard: string) => !question.test(heard) && turningOn.has(once(heard))

/** What what he said turns yapd to, as it is now: off for "Mute." while it's on, on for "unmute" while it's off, and nothing otherwise. */
export const switches = (heard: string, on: boolean) => (on ? (halts(heard) ? false : undefined) : wakes(heard) ? true : undefined)
