import { Clock, Context, Effect, Option, type Scope, Stream, SubscriptionRef } from "effect"
import * as Brain from "./Brain.ts"
import { english } from "./Condenser.ts"
import type { Kept } from "./Journal.ts"
import { addressed, type Lines } from "./Persona.ts"
import * as Process from "./Process.ts"
import type * as Server from "./Server.ts"
import type * as T3Actions from "./T3Actions.ts"
import type * as T3Live from "./T3Live.ts"
import type * as Threads from "./Threads.ts"
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
    /** Puts a card up in place of the one there. */
    readonly put: (draft: Draft) => Effect.Effect<Card>
    /** Takes the card down, and says whether one was up. */
    readonly hide: Effect.Effect<boolean>
    /** One of the cards put up lately. */
    readonly card: (id: string) => Effect.Effect<Option.Option<Card>>
    /** The card that's up, then each time that changes. */
    readonly showing: Stream.Stream<Option.Option<Card>>
    /** The card on his screen: the one that's up, while an app is there to show it. */
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
    /** What was said last and heard last, as a card, while an app watches to show it: for when he asks to hear it again. */
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

/** Whether an address is one to follow: https, and nothing else. */
const secure = (address: string) => /^https:\/\//i.test(address.trim())

/** How much of a thread's own message a card shows. */
const longest = 2500

/**
 * A thread's own markdown, cut to a card's length, with anything that could
 * open something other than an https page taken out: other links keep only
 * their words, and images only their description.
 */
export const tamed = (markdown: string) => {
  // At the end of a line, when there's one to cut at.
  const end = markdown.lastIndexOf("\n", longest)
  const cut = markdown.length <= longest ? markdown : `${markdown.slice(0, end > 0 ? end : longest)}\n…`
  const tame = cut
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\(\s*<?([^)\s>]*)>?[^)]*\)/g, (link, words: string, address: string) => (secure(address) ? link : words))
    .replace(/<([a-z][\w+.-]*:[^>\s]*)>/gi, (link, address: string) => (secure(address) ? link : address))
    .replace(/^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s.*)?$/gm, (definition, address: string) => (secure(address) ? definition : ""))
  // A code block cut short is closed, so the rest of the card isn't taken into it.
  const fences = tame.match(/^ {0,3}(`{3,}|~{3,})/gm) ?? []
  return fences.length % 2 === 0 ? tame : `${tame}\n${fences.at(-1)!.trim()}`
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

/** What a thread waits on, as text only: a command in a code block, never a link. */
const waiting = (request: T3Actions.Request) =>
  request._tag === "Approval"
    ? `### Waiting for your approval\n\n${verbatim(request.what)}`
    : `### Asking you\n\n${request.questions
        .map(({ question, options }) => [plainly(question), ...options.map(({ label }) => `- ${plainly(label)}`)].join("\n\n"))
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
  const url = Option.filter(Option.map(pr, ({ url }) => url), secure)
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
      ...(known?.checks === undefined ? [] : [`- Checks: ${known.checks}`]),
      ...(known?.review === undefined ? [] : [`- Review: ${reviews[known.review] ?? known.review}`]),
      ...(known?.mergeability === undefined || known.state !== "open" ? [] : [`- Mergeable: ${mergeable[known.mergeability] ?? known.mergeability}`]),
      `- Thread: ${plainly(listed.thread.title)}`,
    ]
    const link = secure(url) ? [`[Open the pull request](${url})`] : []
    return {
      kind: "pr",
      title: snapshot === null ? `Pull request #${number}` : snapshot.title,
      markdown: [`**#${number}** in ${plainly(repository)}${known === undefined ? "" : `, ${known.state}`}`, lines.join("\n"), ...link].join("\n\n"),
      ...(secure(url) ? { url } : {}),
    }
  })

/** What a pull request comes to in a line, like "Checks pass, and it's waiting for a review." */
export const verdict = (listed: Threads.Listed, address: string) =>
  Option.match(pullRequest(listed.thread), {
    onNone: () => `${Brain.capital(listed.called)} has no pull request${address}.`,
    onSome: ({ number, snapshot }) => {
      if (snapshot === null) return `That's pull request ${number}${address}.`
      const { state, checks, review, mergeability } = facts(snapshot)
      if (state !== "open") return `It's ${state}${address}.`
      const parts = [
        ...(checks === "passing" ? ["checks pass"] : checks === "failing" ? ["checks are failing"] : checks === "pending" ? ["checks are still running"] : []),
        ...(review === "approved" ? ["it's approved"] : review === "changes-requested" ? ["changes were requested"] : review === "review-required" ? ["it's waiting for a review"] : []),
        ...(mergeability === "conflicting" ? ["it has conflicts"] : []),
      ]
      return parts.length === 0 ? `It's open${address}.` : `${Brain.capital(Brain.both(parts))}${address}.`
    },
  })

/** His usage: each provider's windows, how much of each is used, and when it resets. */
export const usage = (usage: Option.Option<T3Actions.Usage>, now: number): Draft => ({
  kind: "usage",
  title: "Usage",
  markdown: Option.match(Option.filter(usage, (usage) => usage.length > 0), {
    onNone: () => "I can't read your usage right now.",
    onSome: (usage) =>
      usage
        .map(({ provider, windows }) =>
          [
            `**${plainly(provider)}**`,
            windows
              .map((window) => {
                const resets = window.resetsAt === undefined ? undefined : Brain.clock(window.resetsAt, now)
                return `- ${Brain.capital(Brain.windowed(window).name)} window: ${Math.round(window.usedPercent)}%${resets === undefined ? "" : `, resets ${resets}`}`
              })
              .join("\n"),
          ].join("\n\n"),
        )
        .join("\n\n"),
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
                  url,
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

    const put = (draft: Draft) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        const card: Card = { ...draft, id: `c${at.toString(36)}${crypto.randomUUID().slice(0, 4)}`, at }
        recent.set(card.id, card)
        for (const id of [...recent.keys()].slice(0, Math.max(0, recent.size - cards))) recent.delete(id)
        yield* SubscriptionRef.set(up, Option.some(card))
        yield* Effect.logInfo(`Showing ${card.kind}: ${card.title}`)
        return card
      })

    const watched = Effect.sync(() => watching > 0)

    const hide = Effect.gen(function* () {
      const was = yield* SubscriptionRef.getAndSet(up, Option.none())
      if (Option.isSome(was)) yield* Effect.logInfo(`Took down ${was.value.kind}: ${was.value.title}`)
      return Option.isSome(was)
    })

    const opening = (thread: T3Live.Thread) =>
      Effect.gen(function* () {
        // Only the address T3 Code has for it, and only https: never one a model wrote, a file or another app's scheme.
        const address = Option.filter(Option.map(pullRequest(thread), ({ url }) => url.trim()), (url) => URL.canParse(url) && new URL(url).protocol === "https:")
        if (Option.isNone(address)) return false
        return yield* open(new URL(address.value).href).pipe(
          Effect.timeout(patience),
          Effect.as(true),
          Effect.catchAll((error) => Effect.logWarning("Could not open the pull request", error).pipe(Effect.as(false))),
        )
      })

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
            const first = Option.flatMap(situation.usage, (usage) => Option.fromNullable(usage[0]))
            const gist = (address: string) =>
              Brain.used(Option.map(first, ({ provider, windows }) => [{ provider, windows: windows.slice(0, 1) }]), "", { ...lines, address: address.replace(/^, /, "") }, now)
            return yield* shown(gist, usage(situation.usage, now), lines)
          }
          case "missed": {
            const count = situation.unheard.length
            const gist = (address: string) =>
              count === 0 ? `You haven't missed anything${address}.` : `${Brain.capital(Brain.count(count))} ${count === 1 ? "thing" : "things"} you haven't heard${address}.`
            return yield* shown(gist, missed(situation.unheard, now), lines)
          }
          case "said": {
            const line = lastSaid(situation)
            if (Option.isNone(line)) return { say: Brain.nothingSaid(lines), card: Option.none(), about: Option.none() }
            const draft = said(line.value, lastHeard(situation))
            return yield* shown(() => line.value, draft, lines)
          }
          case "thread":
          case "pr": {
            if (Option.isNone(target)) return { say: lines.cantTell, card: Option.none(), about: Option.none() }
            const listed = target.value
            const about = Option.some(listed.ref)
            if (how === "pr") {
              const draft = pr(listed)
              if (Option.isNone(draft)) return { say: verdict(listed, addressed(lines)), card: Option.none(), about }
              yield* opening(listed.thread)
              return yield* shown((address) => verdict(listed, address), draft.value, lines, about)
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
      card: (id) => Effect.sync(() => Option.fromNullable(recent.get(id))),
      showing: up.changes,
      seen: Effect.flatMap(watched, (watching) => (watching ? SubscriptionRef.get(up) : Effect.succeed(Option.none<Card>()))),
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
      open: opening,
      present,
      aside: (target, detail, answer, lines) =>
        Effect.gen(function* () {
          const request = Option.getOrUndefined(detail.request)
          const words = request === undefined ? [] : request._tag === "Approval" ? [request.what] : request.questions.map(({ question }) => question)
          if (words.every(readable)) return Option.none()
          const now = yield* Clock.currentTimeMillis
          const say = (yield* watched) ? `${answer} ${lines.onScreen}` : answer
          return Option.some({ say, card: { ...thread(target, Option.some(detail), now), caption: answer } })
        }),
      caption: (line, situation) =>
        Effect.map(watched, (watching) => (watching && line.trim() !== "" ? Option.some(said(line, lastHeard(situation))) : Option.none())),
    } satisfies Show["Type"]
  })
