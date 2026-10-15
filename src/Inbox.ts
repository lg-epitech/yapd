import { type Duration, Effect } from "effect"
import { rm } from "node:fs/promises"
import type { Ticket } from "./ClaudeCode.ts"
import type { Priority } from "./Condenser.ts"
import type { Answer, Question, Update } from "./Conversation.ts"
import type { Timing } from "./Latency.ts"
import type { Started } from "./Voice.ts"

/** An update that is condensed, rendered, and waiting for its turn to be spoken. */
export interface Ready {
  readonly session: string
  readonly priority: Exclude<Priority, "trivial">
  readonly arrivedAt: number
  readonly update: Update
  /** The session's Stop hook, waiting in case the user replies to this update. */
  readonly hook?: Ticket
  /** For an update heard again, how it was asked for. */
  readonly replay?: Replay
  /** Put back to be read again from where he cut in, how far into it that is, in seconds. */
  readonly from?: number
  /** From its Stop to when it was ready, logged as it starts to play: not for one put back, which is timed already. */
  readonly timing?: Timing
}

/** An update asked for again, by its id among those heard, while yapd was on for the `turns`th time. */
export interface Replay {
  readonly id: string
  readonly turns: number
  /** The menu's row it was asked for from, by its key, which "mute it" or "unmute it" said over it is about. */
  readonly menu?: string
}

/**
 * Something yapd has to say for itself, like a question about new work or that
 * it started. Questions count as needing the user.
 */
export interface Notice {
  readonly id: string
  /**
   * An answer to what the user asked, what came of something they asked to
   * be done, like work that started, or a question about it, which they're
   * waiting for, so it goes before anything else; or a notice of yapd's own.
   */
  readonly kind: "answer" | "done" | "question" | "notice"
  /** The open question it asks, which is never asked again once it's cut off. */
  readonly open?: string
  readonly priority: Exclude<Priority, "trivial">
  readonly spoken: string
  /** When what it's about came up, like when the user sent the dictation, which is where it goes among updates. */
  readonly at: number
  /** Whether it's no longer worth saying, asked as its turn comes, and again once words said in its place are rendered, just before it's played. */
  readonly stale: Effect.Effect<boolean>
  /**
   * What's said in its place when `when`, asked just before it's played, says
   * so, like the line without "it's on your screen" once no app is there to
   * show its card: rendered only then, and `used` once it's what's played,
   * never when it can't be rendered and its own words go after all, nor when
   * it went stale meanwhile.
   */
  readonly instead?: { readonly spoken: string; readonly when: Effect.Effect<boolean>; readonly used?: Effect.Effect<void> }
  /** What came of a request held back as a secret, like the model's answer to it: said, but its words are logged nowhere, whatever they are. */
  readonly withheld?: true
  /** Run as it starts being said, which is when the user hears of it: never when it can't be played, and for a question, undone if it breaks off. */
  readonly saying?: Effect.Effect<void>
  /**
   * Run once it's known to be playing, which is as it starts with the audio
   * helper, but with afplay, which can't say, only once it has played to the
   * end: never when it can't be played or breaks off before that's known.
   */
  readonly confirmed?: Effect.Effect<void>
  /** Run once it's been said to the end, or for a question, answered, which is when the user has heard all of it: never when it's cut off, even by a follow-up, dropped or can't be said. */
  readonly heard?: Effect.Effect<void>
  /**
   * Run once it's done with, said or not, like gone stale, dropped or never
   * queued as yapd was off: never while it's put back to be said again.
   */
  readonly gone?: Effect.Effect<void>
  /**
   * The entries in the journal it tells him of, like the one a notice is
   * kept under once it is, or what a catch-up covers: told him as it's
   * said, so not missed meanwhile, nor told again by a catch-up.
   */
  readonly telling?: Effect.Effect<ReadonlyArray<number>>
  /**
   * For a question: what to do with the answer, and when there's none; and
   * when it can't be asked in full, like when the audio helper quits midway,
   * what undoes its `saying`, since it counts as never said.
   */
  readonly question?: Pick<Question, "answer" | "through" | "terms"> & { readonly unanswered: Effect.Effect<void>; readonly unsaid: Effect.Effect<void> }
  /**
   * For an answer: what to make of what the user says over it, or right
   * after it's said to the end, while the microphone stays open as after an
   * update, like a follow-up about the thread it was about.
   */
  readonly followUp?: Answer["followUp"]
  /** With `followUp`, how long the microphone stays open for it once it's been said to the end: as after any answer, unless said. */
  readonly window?: Duration.DurationInput
  /**
   * With `followUp`, whether it's followed up only from its end: it plays
   * through whatever's said over it, listening only for "Mute.", as a notice
   * does, and only what he says once it's ended is a follow-up.
   */
  readonly after?: true
  /**
   * With `followUp`, whether it's said unasked, like a failure: it's followed
   * up only while he's at hand, and otherwise listens only for "Mute.", as a
   * notice does, since who's in the room then may not be him.
   */
  readonly unasked?: true
  /**
   * For what came of something handed over from an update, when it was last
   * worked out, a moment after his last word, how long the Responder and the
   * Brain took, and when it was acted on: logged part by part as it starts
   * to play.
   */
  readonly handoff?: { readonly since: number; readonly responder: number; readonly brain: number; readonly ran: number }
  /** For what came of what he said, from when he stopped talking or pressed to send it, and how long each step took, logged as it starts to play. */
  readonly timing?: Timing
}

/** A notice that is rendered, and waiting for its turn like updates do. */
export interface Said {
  /** The notice's id, which no session has. */
  readonly session: string
  readonly priority: Exclude<Priority, "trivial">
  readonly arrivedAt: number
  readonly notice: Notice
  /** Its whole, which is what it is, however it starts playing. */
  readonly audio: string
  /**
   * How it was rendered, when that was started on its own, which whoever's
   * done with it gives up, removing its files: with its first part, `first`,
   * when that was out before the whole, which it then starts playing from.
   */
  readonly render?: Started
  readonly first?: string
  /** As the notice's, or from when it was told, with its render too, logged as it starts to play. */
  readonly timing?: Timing
}

export type Entry = Ready | Said

/** What's ready to be said: updates, at most one per session, and notices. */
export type Inbox = ReadonlyMap<string, Entry>

export const empty: Inbox = new Map()

/** The file that's played for it. */
export const audio = (entry: Entry) => ("update" in entry ? entry.update.audio : entry.audio)

/**
 * Lets go of what's played for it once it's done with: its render, given up
 * if it's still under way, with its files, when it was started on its own,
 * else its file. Never for one put back to be said again.
 */
export const release = (entry: Entry) =>
  ("update" in entry ? entry.update.render : entry.render)?.abandon ?? Effect.promise(() => rm(audio(entry), { force: true }))

/** Adds an update, replacing any older one from the same session. */
export const add = (inbox: Inbox, ready: Entry): Inbox => new Map(inbox).set(ready.session, ready)

export const remove = (inbox: Inbox, session: string): Inbox => {
  const next = new Map(inbox)
  next.delete(session)
  return next
}

/** What the user asked for first, then what needs them, then the rest. */
const rank = (entry: Entry) =>
  "notice" in entry && entry.notice.kind !== "notice" ? 0 : entry.priority === "needs-you" ? 1 : 2

/**
 * What to say next: what the user asked for, then anything that needs them,
 * then oldest first. While an answer is on its way, only what they asked for,
 * so nothing else comes between them and it.
 */
export const next = (inbox: Inbox, answering = false): Entry | undefined => {
  let best: Entry | undefined
  for (const ready of inbox.values()) {
    if (answering && rank(ready) > 0) continue
    if (best === undefined || rank(ready) < rank(best) || (rank(ready) === rank(best) && ready.arrivedAt < best.arrivedAt)) {
      best = ready
    }
  }
  return best
}
