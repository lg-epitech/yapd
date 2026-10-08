import { Clock, Context, Effect, Option, type Scope, Stream, SubscriptionRef } from "effect"
import * as Brain from "./Brain.ts"
import { english } from "./Condenser.ts"
import type { Kept } from "./Journal.ts"
import { addressed, type Lines } from "./Persona.ts"
import * as Process from "./Process.ts"
import type * as Server from "./Server.ts"
import type * as T3Actions from "./T3Actions.ts"
import type * as T3Live from "./T3Live.ts"
import * as Threads from "./Threads.ts"
import { ago } from "./Writer.ts"

// What yapd puts on the user's screen when they ask to see something: their
// threads, one thread, its pull request, their usage, what they missed or what
// was said last, built from what yapd already has in mind. It's always said in
// a line too, since they may not be looking, and "it's on your screen" only
// while an app is there to show it. The one thing it ever opens is a pull
// request's https address as T3 Code gave it, never an address a model wrote.

/** What a card shows. */
export type Kind = "threads" | "thread" | "pr" | "usage" | "list" | "said"

/** Something put on the user's screen: a title, the card in markdown, and the one address it's about. */
export interface Card {
  readonly id: string
  readonly kind: Kind
  readonly title: string
  readonly markdown: string
  /** An https address from T3 Code's data, like a pull request's, never one a model wrote. */
  readonly url?: string
  /** What yapd said with it. */
  readonly caption?: string
  readonly at: number
}

/** A card before it's put up. */
export type Draft = Omit<Card, "id" | "at">

/** What showing something comes to: what's said, the card put up as it's said, and the thread it's about. */
export interface Shown {
  readonly say: string
  readonly card: Option.Option<Draft>
  readonly about: Option.Option<Threads.Ref>
}

/** Opens an address in the browser. */
export type Opener = (address: string) => Effect.Effect<void, unknown>

/** As `open` does from a terminal. */
const browser: Opener = (address) => Process.run(["open", address])

/** What's on the user's screen, and what's put there. */
export class Show extends Context.Tag("yapd/Show")<
  Show,
  {
    /** Puts a card up in place of the one there, as `line` is said with it. */
    readonly put: (draft: Draft, line?: string) => Effect.Effect<Card>
    /** Takes the card down, and says whether one was up. */
    readonly hide: Effect.Effect<boolean>
    /** Puts one of the cards put up lately back up as it was, with nothing said of it, and says whether there was one. */
    readonly back: (id: string) => Effect.Effect<boolean>
    /** One of the cards put up lately. */
    readonly card: (id: string) => Effect.Effect<Option.Option<Card>>
    /** The card that's up, then each time that changes. */
    readonly showing: Stream.Stream<Option.Option<Card>>
    /** The card on his screen: the one that's up, if it went up while an app was there to show it and one still is. */
    readonly seen: Effect.Effect<Option.Option<Card>>
    /** Whether an app follows yapd's state, so what's put up is seen. */
    readonly watched: Effect.Effect<boolean>
    /** Counts one more app watching, for as long as the scope lasts. */
    readonly watch: Effect.Effect<void, never, Scope.Scope>
    /** Opens a thread's pull request in the browser, only ever at its https address from T3 Code. Says whether it did. */
    readonly open: (thread: T3Live.Thread) => Effect.Effect<boolean>
    /** What showing what he asked for comes to: `how` is the decision's. */
    readonly present: (how: string, target: Option.Option<Threads.Listed>, situation: Brain.Situation, lines: Lines) => Effect.Effect<Shown>
    /**
     * A thread's card to go with an answer about it, when what it waits on
     * can't be read aloud, and the answer with "it's on your screen" while an
     * app watches. None when it can all be said.
     */
    readonly aside: (target: Threads.Listed, detail: T3Actions.Detail, answer: string, lines: Lines) => Effect.Effect<Option.Option<{ readonly say: string; readonly card: Draft }>>
    /**
     * A card to put up as `line` is said again, while an app watches to show
     * it: the one that went up with it, if one did, so it's on his screen as
     * long as it's talked about, and otherwise what was said last and heard
     * last.
     */
    readonly caption: (line: string, situation: Brain.Situation) => Effect.Effect<Option.Option<Draft>>
  }
>() {}

// ---------------------------------------------------------------- markdown

/** Text as it reads in markdown, whatever marks it has: nothing in it becomes a link, a heading or emphasis. */
export const plainly = (text: string) => text.replace(/\s+/g, " ").trim().replace(/[\\`*_[\]<>#|~]/g, "\\$&")

/** Text in a code block as it is, fenced longer than any run of backticks in it, so nothing in it can end the block early. */
export const verbatim = (text: string) => {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(([run]) => run.length))
  const fence = "`".repeat(longest + 1)
  return `${fence}\n${text.replace(/\r\n?/g, "\n").trimEnd()}\n${fence}`
}

/** An address that's safe to follow, written out in full: https, and nothing else, like a file or another app's scheme. */
export const secure = (address: string): Option.Option<string> => {
  const trimmed = address.trim()
  if (!URL.canParse(trimmed)) return Option.none()
  const url = new URL(trimmed)
  return url.protocol === "https:" && url.hostname !== "" ? Option.some(url.href) : Option.none()
}

/** How much of a thread's own message a card shows. */
const longest = 2500

/** What a backslash escapes in markdown: any ASCII punctuation. */
const escapable = /[!-/:-@[-`{-~]/

/** An address in angle brackets, which markdown makes a link of. */
const angled = /<([a-z][a-z0-9+.-]{1,31}:[^\s<>]*)>/iy

/** The length of the run of a character at `at`. */
const run = (line: string, at: number) => {
  let end = at
  while (end < line.length && line[end] === line[at]) end++
  return end - at
}

/** Where the code span opened by the run of `length` backticks before `from` closes on the line, if it does: at the next run as long. */
const spanEnd = (line: string, from: number, length: number) => {
  for (let at = line.indexOf("`", from); at >= 0; at = line.indexOf("`", at + run(line, at))) {
    if (run(line, at) === length) return at
  }
  return undefined
}

/**
 * The inline link or image whose `[` is at `at`, as in `[words](address
 * "title")`: its words, where it goes, and where it ends. Nothing when it
 * isn't one, like a bracket on its own or a link to a definition.
 */
const linkAt = (line: string, at: number, closing: ReadonlyMap<number, number>) => {
  const close = closing.get(at)
  if (close === undefined || line[close + 1] !== "(") return undefined
  const blank = (end: number) => {
    while (line[end] === " " || line[end] === "\t") end++
    return end
  }
  const start = blank(close + 2)
  let end = start
  let address: string
  if (line[start] === "<") {
    end = line.indexOf(">", start)
    if (end < 0 || line.slice(start + 1, end).includes("<")) return undefined
    address = line.slice(start + 1, end++)
  } else {
    // Up to a space or the bracket that closes it, past any it opens.
    for (let depth = 0; end < line.length && line[end]! > " "; end++) {
      if (line[end] === "\\" && escapable.test(line[end + 1] ?? "")) end++
      else if (line[end] === "(") depth++
      else if (line[end] === ")" && depth-- === 0) break
    }
    address = line.slice(start, end)
  }
  // A title, after a space, in quotes or brackets.
  const spaced = blank(end)
  const quote = ({ '"': '"', "'": "'", "(": ")" } as Readonly<Record<string, string>>)[line[spaced] ?? ""]
  if (quote !== undefined && spaced > end) {
    end = spaced + 1
    while (end < line.length && line[end] !== quote) end += line[end] === "\\" ? 2 : 1
    if (end >= line.length) return undefined
    end = blank(end + 1)
  } else {
    end = spaced
  }
  if (line[end] !== ")") return undefined
  return { words: line.slice(at + 1, close), address: address.replace(/\\([!-/:-@[-`{-~])/g, "$1"), end: end + 1 }
}

/**
 * Where a link to `address` goes, written after it, unless its words are that
 * address: words can name one page and link to another, like a GitHub address
 * that opens a page made to look like GitHub, however they're spelled.
 */
const where = (words: string, address: string) => {
  const said = words.replace(/\\([!-/:-@[-`{-~])/g, "$1").trim()
  return said === address || `${said}/` === address ? "" : ` (${plainly(new URL(address).host)})`
}

/**
 * A line of a thread's own markdown with nothing in it that could link but
 * the links to https pages, written again with where they go: every other
 * bracket, angle bracket and backtick is escaped, but in a code span, which
 * is kept as it is. Other links keep only their words, images only their
 * description, and a link's words, `linking` off, keep no link of their own.
 */
const unlinked = (line: string, linking = true): string => {
  // Each `[` with the `]` that closes it, nesting as markdown does.
  const closing = new Map<number, number>()
  const opened: Array<number> = []
  for (let at = 0; at < line.length; at++) {
    if (line[at] === "\\") at++
    else if (line[at] === "[") opened.push(at)
    else if (line[at] === "]" && opened.length > 0) closing.set(opened.pop()!, at)
  }
  let out = ""
  let at = 0
  while (at < line.length) {
    const char = line[at]!
    if (char === "\\" && escapable.test(line[at + 1] ?? "")) {
      out += line.slice(at, at + 2)
      at += 2
    } else if (char === "`") {
      const length = run(line, at)
      const end = spanEnd(line, at + length, length)
      // Not one with a pipe in it, which a table would split into cells that are read as markdown.
      if (end === undefined || line.slice(at, end).includes("|")) {
        out += "\\`".repeat(length)
        at += length
      } else {
        out += line.slice(at, end + length)
        at = end + length
      }
    } else if (char === "[" || (char === "!" && line[at + 1] === "[")) {
      const image = char === "!"
      const link = linkAt(line, image ? at + 1 : at, closing)
      if (link === undefined) {
        out += image ? "!\\[" : "\\["
        at += image ? 2 : 1
      } else {
        const words = unlinked(link.words, false)
        const address = linking && !image ? secure(link.address) : Option.none()
        // In angle brackets, so nothing in the address can end the link early.
        out += Option.match(address, { onNone: () => words, onSome: (address) => `[${words}](<${address}>)${where(link.words, address)}` })
        at = link.end
      }
    } else if (char === "<") {
      angled.lastIndex = at
      const found = angled.exec(line)
      const address = linking && found !== null ? secure(found[1]!) : Option.none()
      // An address in angle brackets stays a link when it's to an https page, and anything else in them is only text, HTML too.
      out += Option.match(address, { onNone: () => "\\<", onSome: (address) => `<${address}>` })
      at += Option.isSome(address) ? found![0].length : 1
    } else {
      out += char === "]" ? "\\]" : char
      at++
    }
  }
  return out
}

/**
 * A thread's own markdown, cut to a card's length, with nothing that could
 * open anything but an https page: no other link, no image, no definition a
 * link could point at, no address in angle brackets and no HTML. Code blocks
 * are kept as they are, which nothing in can link from.
 */
export const tamed = (markdown: string) => {
  const text = markdown.replace(/\r\n?/g, "\n")
  // At the end of a line, when there's one to cut at.
  const end = text.lastIndexOf("\n", longest)
  const cut = text.length <= longest ? text : `${text.slice(0, end > 0 ? end : longest)}\n…`
  let fence: { readonly mark: string; readonly length: number } | undefined
  const lines = cut.split("\n").map((line) => {
    if (fence !== undefined) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)?.[1]
      if (closing !== undefined && closing[0] === fence.mark && closing.length >= fence.length) fence = undefined
      return line
    }
    // Only a fence at the very start of a line opens a code block whatever comes before it, so only that one is kept as it is.
    const opening = /^(`{3,})[^`]*$|^(~{3,})/.exec(line)
    if (opening === null) return unlinked(line)
    const mark = opening[1] ?? opening[2]!
    fence = { mark: mark[0]!, length: mark.length }
    return line
  })
  // A code block cut short is closed, so the rest of the card isn't taken into it.
  return [...lines, ...(fence === undefined ? [] : [fence.mark.repeat(fence.length)])].join("\n")
}

// ---------------------------------------------------------------- cards

const day = 24 * 60 * 60_000

/** A thread's pull request as T3 Code has it: the latest it links that wasn't dismissed, else the one on its branch. */
export const pullRequest = (thread: T3Live.Thread) => {
  const linked = thread.pullRequests.filter(({ source }) => source !== "stack-dismissed").at(-1)
  if (linked !== undefined) return Option.some({ number: linked.number, url: linked.url, repository: linked.repository, snapshot: linked.snapshot })
  return Option.map(Option.fromNullable(thread.branchPullRequest), ({ number, url, repository }) => ({ number, url, repository, snapshot: null }))
}

/** A pull request's state, checks, review and mergeability, as T3 Code words them, in lower case. */
const facts = (snapshot: NonNullable<T3Live.Thread["pullRequests"][number]["snapshot"]>) => ({
  state: snapshot.state.toLowerCase(),
  checks: snapshot.checksState?.toLowerCase(),
  review: snapshot.reviewDecision?.toLowerCase(),
  mergeability: snapshot.mergeability?.toLowerCase(),
})

const reviews: Readonly<Record<string, string>> = {
  approved: "approved",
  "changes-requested": "changes requested",
  "review-required": "waiting for a review",
}

const mergeable: Readonly<Record<string, string>> = { mergeable: "yes", conflicting: "no, it has conflicts", unknown: "not known yet" }

/** A pull request in a few words for a thread's line, like "PR #412 open, checks passing". */
const briefly = (thread: T3Live.Thread) =>
  Option.map(pullRequest(thread), ({ number, snapshot }) => {
    if (snapshot === null) return `PR #${number}`
    const { state, checks } = facts(snapshot)
    return `PR #${number} ${state}${checks === undefined ? "" : `, checks ${checks}`}`
  })

/** What a thread is doing, as a card says it. */
const status = (listed: Threads.Listed, now: number) => {
  switch (listed.state) {
    case "running":
      return `running, started ${ago(listed.since, now)}`
    case "finishing":
      return "finishing"
    case "queued":
      return "queued"
    case "approval":
      return "waiting for your approval"
    case "question":
      return "asking you something"
    case "failed":
      return `failed ${ago(listed.since, now)}`
    case "limited": {
      const resets = listed.thread.usageLimitResetAt === null ? undefined : Brain.clock(listed.thread.usageLimitResetAt, now)
      return `hit its usage limit${resets === undefined ? "" : `, resets ${resets}`}`
    }
    case "idle":
      return `idle, last ran ${ago(listed.since, now)}`
  }
}

/** A thread in one line of a card. */
const row = (listed: Threads.Listed, now: number) =>
  [
    `**${plainly(listed.thread.title)}**`,
    plainly(listed.project),
    ...(listed.here ? [] : [listed.ref.machine]),
    status(listed, now),
    ...Option.toArray(briefly(listed.thread)),
  ].join(" · ")

/** How many threads that ran in the last day, and did nothing else since, a card lists at most. */
const lately = 6

/** The groups a card of threads has, in order, and which threads go in each. */
const groups = (now: number): ReadonlyArray<readonly [string, (listed: Threads.Listed) => boolean]> => [
  ["Needs you", ({ state }) => state === "approval" || state === "question"],
  ["Running", ({ state }) => state === "running" || state === "finishing" || state === "queued"],
  [
    "Failed",
    ({ state, since, thread }) => (state === "failed" || state === "limited") && thread.settledOverride !== "settled" && now - since < day,
  ],
  ["Lately", ({ state, since }) => state === "idle" && now - since < day],
]

/** Of the threads on the desk, those a card of threads lists, by group. */
const grouped = (desk: Threads.Desk, now: number) =>
  groups(now).map(([name, belongs]) => {
    const all = desk.threads.filter((listed) => !listed.brief && belongs(listed))
    return [name, name === "Lately" ? all.slice(0, lately) : all] as const
  })

/** What's going on across his threads, grouped by what they're doing, with their pull requests, and the machines it can't see. */
export const overview = (desk: Threads.Desk, now: number): Draft => {
  const sections = grouped(desk, now)
    .filter(([, threads]) => threads.length > 0)
    .map(([name, threads]) => `### ${name}\n\n${threads.map((listed) => `- ${row(listed, now)}`).join("\n")}`)
  const away = desk.away.map(({ reason }) => `_${plainly(reason)}_`)
  const markdown = [...(sections.length === 0 && away.length === 0 ? ["Nothing's running, and nothing ran in the last day."] : sections), ...away]
  return { kind: "threads", title: "What's going on", markdown: markdown.join("\n\n") }
}

/** What a card of threads comes to in a line, like "Two running and one needs you." */
export const tally = (desk: Threads.Desk, address: string, now: number) => {
  const [needs = 0, running = 0, failed = 0] = grouped(desk, now).map(([, threads]) => threads.length)
  if (desk.threads.length === 0 && desk.away.length > 0) return desk.away.map(({ reason }) => reason).join(" ")
  const parts = [
    ...(running === 0 ? [] : [`${Brain.count(running)} running`]),
    ...(needs === 0 ? [] : [`${Brain.count(needs)} ${needs === 1 ? "needs" : "need"} you`]),
    ...(failed === 0 ? [] : [`${Brain.count(failed)} failed`]),
  ]
  return parts.length === 0 ? `Nothing's running${address}.` : `${Brain.capital(Brain.both(parts))}${address}.`
}

/**
 * What a thread waits on, as text only, in code blocks: a command, or a
 * question with its choices, where nothing written out, like an address, can
 * become a link.
 */
const waiting = (request: T3Actions.Request) =>
  request._tag === "Approval"
    ? `### Waiting for your approval\n\n${verbatim(request.what)}`
    : `### Asking you\n\n${request.questions
        .map(({ question, options }) => verbatim([question, ...options.map(({ label }) => `- ${label}`)].join("\n")))
        .join("\n\n")}`

/** A thread: where and how it's doing, what it waits on, its latest message and its plan. */
export const thread = (listed: Threads.Listed, detail: Option.Option<T3Actions.Detail>, now: number): Draft => {
  const pr = pullRequest(listed.thread)
  const message = Option.flatMap(detail, ({ messages }) => Option.fromNullable(messages.filter(({ role }) => role === "assistant").at(-1)))
  const request = Option.flatMap(detail, ({ request }) => request)
  const markdown = [
    [plainly(listed.project), listed.ref.machine, status(listed, now), ...Option.toArray(briefly(listed.thread))].join(" · "),
    ...Option.match(request, {
      onSome: (request) => [waiting(request)],
      onNone: () => (listed.thread.pendingRuntimeRequest === null ? [] : ["### Waiting for you\n\nI couldn't read what it's waiting for just now."]),
    }),
    ...Option.match(message, { onNone: () => [], onSome: ({ text }) => [`### Latest\n\n${tamed(text)}`] }),
    ...Option.match(Option.flatMap(detail, ({ plan }) => plan), { onNone: () => [], onSome: (plan) => [`### Plan\n\n${tamed(plan)}`] }),
  ].join("\n\n")
  const url = Option.flatMap(pr, ({ url }) => secure(url))
  return { kind: "thread", title: listed.thread.title, markdown, ...Option.match(url, { onNone: () => ({}), onSome: (url) => ({ url }) }) }
}

/** What a thread is doing, as said after its name. */
const telling: Readonly<Record<Threads.State, string>> = {
  running: "is running",
  finishing: "is finishing",
  queued: "is queued",
  approval: "wants your approval",
  question: "has a question for you",
  failed: "failed",
  limited: "hit its usage limit",
  idle: "is idle",
}

/** A thread's pull request: what it is, where, its checks, review and whether it can merge, and the link to it. */
export const pr = (listed: Threads.Listed): Option.Option<Draft> =>
  Option.map(pullRequest(listed.thread), ({ number, url, repository, snapshot }) => {
    const known = snapshot === null ? undefined : facts(snapshot)
    const lines = [
      ...(known?.checks === undefined ? [] : [`- Checks: ${plainly(known.checks)}`]),
      ...(known?.review === undefined ? [] : [`- Review: ${reviews[known.review] ?? plainly(known.review)}`]),
      ...(known?.mergeability === undefined || known.state !== "open" ? [] : [`- Mergeable: ${mergeable[known.mergeability] ?? plainly(known.mergeability)}`]),
      `- Thread: ${plainly(listed.thread.title)}`,
    ]
    const address = secure(url)
    return {
      kind: "pr",
      title: snapshot === null ? `Pull request #${number}` : snapshot.title,
      markdown: [
        `**#${number}** in ${plainly(repository)}${known === undefined ? "" : `, ${plainly(known.state)}`}`,
        lines.join("\n"),
        // In angle brackets, so nothing in the address can end the link early.
        ...Option.match(address, {
          onNone: () => ["_No link: the address T3 Code has for it isn't a secure web page._"],
          onSome: (address) => [`[Open the pull request](<${address}>)`],
        }),
      ].join("\n\n"),
      ...Option.match(address, { onNone: () => ({}), onSome: (url) => ({ url }) }),
    }
  })

/**
 * What a pull request comes to in a line, like "Checks pass and it's waiting
 * for a review." `named`, it says whose it is first, like "The Tezos
 * migration: checks pass…", so a thread taken on a guess is heard.
 */
export const verdict = (listed: Threads.Listed, address: string, named = false) =>
  Option.match(pullRequest(listed.thread), {
    onNone: () => `${Brain.capital(listed.called)} has no pull request${address}.`,
    onSome: ({ number, snapshot }) => {
      const line = (said: string) => `${named ? `${Brain.capital(listed.called)}: ${said.charAt(0).toLowerCase()}${said.slice(1)}` : said}${address}.`
      if (snapshot === null) return line(`That's pull request ${number}`)
      const { state, checks, review, mergeability } = facts(snapshot)
      if (state !== "open") return line(`It's ${state}`)
      const parts = [
        ...(checks === "passing" ? ["checks pass"] : checks === "failing" ? ["checks are failing"] : checks === "pending" ? ["checks are still running"] : []),
        ...(review === "approved" ? ["it's approved"] : review === "changes-requested" ? ["changes were requested"] : review === "review-required" ? ["it's waiting for a review"] : []),
        ...(mergeability === "conflicting" ? ["it has conflicts"] : []),
      ]
      return line(parts.length === 0 ? "It's open" : Brain.capital(Brain.both(parts)))
    },
  })

/**
 * His usage: each provider's windows, how much of each is used, and when it
 * resets. Read too long ago to be what's used now, it says when it was read,
 * and a window that has reset since says only that.
 */
export const usage = (usage: Option.Option<Threads.Usage>, now: number): Draft => ({
  kind: "usage",
  title: "Usage",
  markdown: Option.match(Option.filter(usage, ({ providers }) => providers.length > 0), {
    onNone: () => "I can't read your usage right now.",
    onSome: ({ at, providers }) =>
      [
        ...(now - at > Threads.dated ? [`_As of ${Brain.time(at)}, when T3 Code last answered._`] : []),
        ...providers.map(({ provider, windows }) =>
          [
            `**${plainly(provider)}**`,
            windows
              .map((window) => {
                const name = plainly(Brain.capital(Brain.windowed(window).name))
                if (window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now) return `- ${name} window: reset since`
                const resets = window.resetsAt === undefined ? undefined : Brain.clock(window.resetsAt, now)
                return `- ${name} window: ${Math.round(window.usedPercent)}%${resets === undefined ? "" : `, resets ${resets}`}`
              })
              .join("\n"),
          ].join("\n\n"),
        ),
      ].join("\n\n"),
  }),
})

/** What he hasn't heard, newest last, as the journal has it. */
export const missed = (unheard: ReadonlyArray<Kept>, now: number): Draft => ({
  kind: "list",
  title: "What you missed",
  markdown:
    unheard.length === 0
      ? "Nothing you haven't heard."
      : unheard
          .map((kept) => `- **${ago(kept.at, now)}**${kept.project === undefined ? "" : ` · ${plainly(kept.project)}`}: ${plainly(kept.said ?? kept.text ?? "")}`)
          .join("\n"),
})

/** The last thing he said that yapd heard, before this. */
const lastHeard = (situation: Brain.Situation) =>
  Option.fromNullable(situation.lately.findLast(({ kind, text }) => (kind === "dictation" || kind === "reply") && (text ?? "").trim() !== "")?.text)

/** The last line said, as he heard it, and the last thing he said, as yapd heard it. */
export const said = (line: string, heard: Option.Option<string>): Draft => ({
  kind: "said",
  title: "What I said",
  markdown: [`### I said\n\n${plainly(line)}`, ...Option.match(heard, { onNone: () => [], onSome: (heard) => [`### I heard you say\n\n${plainly(heard)}`] })].join("\n\n"),
})

/** A line in his style without addressing him, like "It's on your screen.", for after one that did already. */
const unaddressed = (line: string, { address }: Pick<Lines, "address">) => {
  const word = address.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  if (word === "") return line
  return Brain.capital(line.replace(new RegExp(`^${word},\\s*`, "i"), "").replace(new RegExp(`,\\s*${word}(?=[.!?]*$)`, "i"), ""))
}

/** A line said with a card, without "it's on your screen", which is only true while an app shows it: what's said of it again. */
export const offScreen = (line: string, lines: Lines) =>
  [lines.onScreen, unaddressed(lines.onScreen, lines)]
    .reduce((rest, phrase) => (phrase.trim() === "" ? rest : rest.replace(phrase, "")), line)
    .replace(/\s+/g, " ")
    .trim()

/** What yapd said last, when there's anything to say again. */
const lastSaid = (situation: Brain.Situation) =>
  situation.subject._tag === "Nothing"
    ? Option.fromNullable(situation.lately.findLast(({ kind, said }) => kind !== "dictation" && (said ?? "").trim() !== "")?.said)
    : Option.some(situation.subject.said)

/** Whether words can be said as they are: nothing a voice would spell out or skip, like a path, a flag, a link or a command's punctuation. */
export const readable = (text: string) => {
  const squashed = text.replace(/\s+/g, " ").trim()
  return squashed !== "" && english(squashed) && !/[`$|&;<>{}\\=~]|(^|\s)--?\w|\w\/\w/.test(squashed) && Brain.speakable(squashed, { threads: [], away: [] }) === squashed
}

// ---------------------------------------------------------------- the API's

/** The threads on each machine as `/threads` lists them, those that need him first, and the machines it can't see with why. */
export const listing = (desk: Threads.Desk): ReadonlyArray<Server.Machine> => {
  const machines = [...new Set(desk.threads.map(({ ref }) => ref.machine))]
  return [
    ...machines.map((machine) => ({
      machine,
      threads: desk.threads
        .filter(({ ref }) => ref.machine === machine)
        .map((listed) => ({
          id: listed.ref.id,
          project: listed.project,
          title: listed.thread.title,
          state: listed.state,
          since: new Date(listed.since).toISOString(),
          ...Option.match(pullRequest(listed.thread), {
            onNone: () => ({}),
            onSome: ({ number, url, snapshot }) => {
              const known = snapshot === null ? undefined : facts(snapshot)
              return {
                pr: {
                  number,
                  // Only an https address, as on a card: any agent can link a thread to one of any kind.
                  ...Option.match(secure(url), { onNone: () => ({}), onSome: (url) => ({ url }) }),
                  ...(known === undefined ? {} : { state: known.state }),
                  ...(known?.checks === undefined ? {} : { checks: known.checks }),
                  ...(known?.review === undefined ? {} : { review: known.review }),
                  ...(known?.mergeability === undefined ? {} : { mergeability: known.mergeability }),
                },
              }
            },
          }),
        })),
    })),
    ...desk.away.map(({ machine, reason }) => ({ machine, reason, threads: [] })),
  ]
}

/** A journal entry as `/journal` returns it. */
export const entry = (kept: Kept): Server.Entry => ({
  id: kept.id,
  at: new Date(kept.at).toISOString(),
  kind: kept.kind,
  ...(kept.machine === undefined ? {} : { machine: kept.machine }),
  ...(kept.project === undefined ? {} : { project: kept.project }),
  ...(kept.thread === undefined ? {} : { thread: kept.thread }),
  ...(kept.said === undefined ? {} : { said: kept.said }),
  ...(kept.text === undefined ? {} : { text: kept.text }),
  ...(kept.utterance === undefined ? {} : { utterance: kept.utterance }),
  ...(kept.heardAt === undefined ? {} : { heard: new Date(kept.heardAt).toISOString() }),
})

/** A card as `/cards/{id}` returns it, and, without its markdown, as `/state` points at it. */
export const face = (card: Card): Server.Card => ({
  id: card.id,
  kind: card.kind,
  title: card.title,
  markdown: card.markdown,
  ...(card.url === undefined ? {} : { url: card.url }),
  ...(card.caption === undefined ? {} : { caption: card.caption }),
  at: new Date(card.at).toISOString(),
})

/** The card that's up, as `/state` points at it. */
export const pointer = (card: Option.Option<Card>): Server.Showing | null =>
  Option.match(card, { onNone: () => null, onSome: ({ id, kind, title, at }) => ({ id, kind, title, at: new Date(at).toISOString() }) })

/** The state as `/state` gives it, with the card that's up, then each time either changes. */
export const stated = (state: Stream.Stream<Omit<Server.State, "showing">>, show: Show["Type"]): Stream.Stream<Server.State> =>
  Stream.zipLatestWith(state, show.showing, (state, showing) => ({ ...state, showing: pointer(showing) }))

/** What the API serves of the cards, the threads on `desk` and the journal's pages, and how it counts a UI that shows cards as watching. */
export const served = (
  show: Show["Type"],
  desk: Effect.Effect<Threads.Desk>,
  page: (page: Server.Page) => Effect.Effect<ReadonlyArray<Kept>>,
): Pick<Server.Api, "card" | "hide" | "back" | "threads" | "journal" | "watch"> => ({
  card: (id) => Effect.map(show.card(id), Option.map(face)),
  hide: Effect.asVoid(show.hide),
  back: show.back,
  threads: Effect.map(desk, listing),
  journal: (asked) => Effect.map(page(asked), (kept) => kept.map(entry)),
  watch: show.watch,
})

// ---------------------------------------------------------------- the service

/** How many cards are kept to fetch again, like the one before the one that's up. */
const cards = 20

/** How long reading a thread for its card, or opening its pull request, can hold up what's said. */
const patience = "3 seconds"

/** What's on the user's screen, reading threads with `read` for their cards, and opening pull requests with `open`. */
export const make = (read: Threads.Threads["Type"]["detail"], open: Opener = browser) =>
  Effect.gen(function* () {
    const up = yield* SubscriptionRef.make(Option.none<Card>())
    const recent = new Map<string, Card>()
    let watching = 0
    // Whether the card that's up went up while an app was there to show it: one put up before isn't on his screen, even once an app is.
    let shownTo = false
    // The last card that went up as something was said, and what was: said again, it goes up again, whether it's still up or not.
    let withLine: { readonly line: string; readonly draft: Draft } | undefined

    const put = (draft: Draft, line?: string) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        const card: Card = { ...draft, id: `c${at.toString(36)}${crypto.randomUUID().slice(0, 4)}`, at }
        recent.set(card.id, card)
        for (const id of [...recent.keys()].slice(0, Math.max(0, recent.size - cards))) recent.delete(id)
        shownTo = watching > 0
        if (line !== undefined) withLine = { line, draft }
        yield* SubscriptionRef.set(up, Option.some(card))
        yield* Effect.logInfo(`Showing ${card.kind}: ${card.title}`)
        return card
      })

    const watched = Effect.sync(() => watching > 0)

    const seen = Effect.flatMap(watched, (watching) => (watching && shownTo ? SubscriptionRef.get(up) : Effect.succeed(Option.none<Card>())))

    const hide = Effect.gen(function* () {
      const was = yield* SubscriptionRef.getAndSet(up, Option.none())
      if (Option.isSome(was)) yield* Effect.logInfo(`Took down ${was.value.kind}: ${was.value.title}`)
      return Option.isSome(was)
    })

    /** Opens a thread's pull request, and says whether it did, or why not: its address isn't https, or the browser didn't open it in time. */
    const opening = (thread: T3Live.Thread) =>
      Effect.gen(function* () {
        // Only the address T3 Code has for it, and only https: never one a model wrote, a file or another app's scheme.
        const address = Option.flatMap(pullRequest(thread), ({ url }) => secure(url))
        if (Option.isNone(address)) return "unsafe" as const
        return yield* open(address.value).pipe(
          Effect.timeout(patience),
          Effect.as("opened" as const),
          Effect.catchAll((error) => Effect.logWarning("Could not open the pull request", error).pipe(Effect.as("failed" as const))),
        )
      })

    /** What's said after a pull request's verdict when it didn't open, so he isn't left waiting on a browser. */
    const unopened = { opened: "", unsafe: " Its address isn't a secure web page, so I haven't opened it.", failed: " I couldn't open it in your browser." }

    /** A line said with a card: "it's on your screen" first while an app watches, and then without addressing him again. */
    const told = (gist: (address: string) => string, lines: Lines) =>
      Effect.map(watched, (watching) => (watching ? `${lines.onScreen} ${gist("")}` : gist(addressed(lines))))

    const shown = (gist: (address: string) => string, draft: Draft, lines: Lines, about: Option.Option<Threads.Ref> = Option.none()) =>
      Effect.map(told(gist, lines), (say): Shown => ({ say, card: Option.some({ ...draft, caption: gist(addressed(lines)) }), about }))

    const present = (how: string, target: Option.Option<Threads.Listed>, situation: Brain.Situation, lines: Lines): Effect.Effect<Shown> =>
      Effect.gen(function* () {
        const { now } = situation
        switch (how) {
          case "hide":
            yield* hide
            return { say: "", card: Option.none(), about: Option.none() }
          case "threads":
            return yield* shown((address) => tally(situation.desk, address, now), overview(situation.desk, now), lines)
          case "usage": {
            // The first provider's first window, which the card puts first too.
            const first = Option.map(situation.usage, ({ at, providers }) => ({ at, providers: providers.slice(0, 1).map(({ provider, windows }) => ({ provider, windows: windows.slice(0, 1) })) }))
            const gist = (address: string) => Brain.used(first, "", { ...lines, address: address.replace(/^, /, "") }, now)
            return yield* shown(gist, usage(situation.usage, now), lines)
          }
          case "missed": {
            const count = situation.unheard.length
            const gist = (address: string) =>
              count === 0 ? `You haven't missed anything${address}.` : `${Brain.capital(Brain.count(count))} ${count === 1 ? "thing" : "things"} you haven't heard${address}.`
            return yield* shown(gist, missed(situation.unheard, now), lines)
          }
          case "said": {
            const line = Option.filter(Option.map(lastSaid(situation), (line) => offScreen(line, lines)), (line) => line !== "")
            if (Option.isNone(line)) return { say: Brain.nothingSaid(lines), card: Option.none(), about: Option.none() }
            const draft = said(line.value, lastHeard(situation))
            return yield* shown(() => line.value, draft, lines)
          }
          case "thread":
          case "pr": {
            if (Option.isNone(target)) return { say: Brain.unseen(situation.desk, lines) ?? lines.cantTell, card: Option.none(), about: Option.none() }
            const listed = target.value
            const about = Option.some(listed.ref)
            if (how === "pr") {
              const draft = pr(listed)
              if (Option.isNone(draft)) return { say: verdict(listed, addressed(lines)), card: Option.none(), about }
              const opened = yield* opening(listed.thread)
              // Unless it's the thread just talked about, whose it is comes first, since the browser opens it whether or not he's looking.
              const named = !Option.exists(Brain.focused(situation), ({ ref }) => ref.machine === listed.ref.machine && ref.id === listed.ref.id)
              return yield* shown((address) => `${verdict(listed, address, named)}${unopened[opened]}`, draft.value, lines, about)
            }
            // What it says is there either way, so a T3 Code that's slow to answer only leaves its messages off the card.
            const detail = yield* read(listed.ref, listed.thread.pendingRuntimeRequest?.id).pipe(
              Effect.timeout(patience),
              Effect.tapError((error) => Effect.logWarning(`Could not read ${listed.called} for its card`, error)),
              Effect.option,
            )
            return yield* shown((address) => `${Brain.capital(listed.called)} ${telling[listed.state]}${address}.`, thread(listed, detail, now), lines, about)
          }
          default:
            return { say: Brain.notYet(lines), card: Option.none(), about: Option.none() }
        }
      })

    return {
      put,
      hide,
      back: (id) =>
        Effect.gen(function* () {
          const card = recent.get(id)
          if (card === undefined) return false
          // The latest shown again, so it's kept as long as one just made.
          recent.delete(id)
          recent.set(id, card)
          shownTo = watching > 0
          yield* SubscriptionRef.set(up, Option.some(card))
          yield* Effect.logInfo(`Showing ${card.kind} again: ${card.title}`)
          return true
        }),
      card: (id) => Effect.sync(() => Option.fromNullable(recent.get(id))),
      showing: up.changes,
      seen,
      watched,
      watch: Effect.acquireRelease(
        Effect.sync(() => {
          watching++
        }),
        () =>
          Effect.sync(() => {
            watching--
          }),
      ),
      open: (thread) => Effect.map(opening(thread), (opened) => opened === "opened"),
      present,
      aside: (target, detail, answer, lines) =>
        Effect.gen(function* () {
          const request = Option.getOrUndefined(detail.request)
          // A question's choices too, which he can't pick between by ear when they're commands or addresses.
          const words =
            request === undefined
              ? []
              : request._tag === "Approval"
                ? [request.what]
                : request.questions.flatMap(({ question, options }) => [question, ...options.map(({ label }) => label)])
          if (words.every(readable)) return Option.none()
          const now = yield* Clock.currentTimeMillis
          // The answer addressed him already.
          const say = (yield* watched) ? `${answer} ${unaddressed(lines.onScreen, lines)}` : answer
          return Option.some({ say, card: { ...thread(target, Option.some(detail), now), caption: answer } })
        }),
      caption: (line, situation) =>
        Effect.gen(function* () {
          if (!(yield* watched) || line.trim() === "") return Option.none()
          // Like a thread's card with a command he couldn't hear, which is what he'd want to see while it's said again. Put up
          // anew, it fades only once this is said, not a while after it was first. Said again before, it went up with the line
          // as it was said then, without "it's on your screen".
          const repeated = situation.subject._tag === "Nothing" ? undefined : situation.subject.said
          if (withLine !== undefined && (withLine.line === repeated || withLine.line === line)) return Option.some(withLine.draft)
          return Option.some(said(line, lastHeard(situation)))
        }),
    } satisfies Show["Type"]
  })
