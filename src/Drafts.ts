import { Cause, Clock, type Duration, Effect, Either, Fiber, Option, type Scope } from "effect"
import type { Notice } from "./Inbox.ts"
import { type Catalog, LaunchError, type Launcher, type Request, type Started } from "./Launcher.ts"
import type { Delivery, Outbox } from "./Outbox.ts"
import type { Heard } from "./Recent.ts"
import type { Records } from "./Records.ts"
import { Reporter } from "./Reporter.ts"
import type { Researcher } from "./Research.ts"
import type { Line } from "./Responder.ts"
import { type Known, type Listed, type Threads, ThreadsError } from "./Threads.ts"
import {
  type Decision,
  type Destination,
  grounded,
  groundedThread,
  key,
  type Listing,
  type Material,
  parseKey,
  shortlist,
  type ThreadListing,
  vocabulary,
  Writer,
} from "./Writer.ts"

// What the user dictated becomes a draft: written in the background, however
// many there are, while updates keep being read. It's new work to start, a
// message for an agent already at work, or a question about where their work
// stands. What a draft has to say, a question, that it's reading the project,
// what it did or why it didn't, waits for its turn like updates do, and an
// answer goes back to the draft that asked. Drafts only live in memory: what
// the user said is in the log from the start, so one that's lost can be
// dictated again, and none acts later than the user would expect it to.

/** A machine work runs on. */
export interface Machine {
  /** What the user calls it. */
  readonly name: string
  readonly here: boolean
  /** Names its hooks may report it by. */
  readonly hosts: ReadonlyArray<string>
  readonly launcher: Launcher
  readonly researcher: Researcher
  readonly threads: Threads
}

/** How long a machine has to say what it can start, and what threads it has, from when the shortcut is pressed. */
const patience: Duration.DurationInput = "8 seconds"
/** Catalogs older than this are fetched again, like when a dictation is sent long after the shortcut was pressed. */
const fresh = 5 * 60_000
/** Threads go stale much faster: a turn can end in the time it takes to talk. */
const freshThreads = 60_000
/** How long after a question went unanswered it's asked again. */
const again: Duration.DurationInput = "1 minute"
/** How many times a question is asked before the request is dropped. */
const asks = 2
/** Prompts being written at once. */
const writers = 3
/** Threads' first messages being fetched at once, in the background. */
const learners = 4
/** How long fetching one may take: it reads the whole thread. */
const reading: Duration.DurationInput = "20 seconds"
/** How long after a first message couldn't be fetched it's asked for again. */
const relearn = 15 * 60_000
/** How many of a thread's latest turns are read to say where it stands. */
const turns = 3

interface Draft {
  readonly id: string
  readonly heard: string
  /** When the user sent it. */
  readonly at: number
  readonly lines: Array<Line>
  /** The request in a few words, once the writer has named it. */
  about: string
  /** How many times the question it's waiting on went unanswered. */
  unanswered: number
  /** Whether it's being acted on right now, which can't be taken back. */
  starting: boolean
  open: boolean
}

interface Resolved {
  /** Whether what they said about a worktree could be heard either way. */
  readonly unsure: boolean
  readonly machine: Machine
  readonly project: Catalog["projects"][number]
  readonly catalog: Catalog
  readonly request: Request
}

/** A listed thread the user's words settled, with the machine it's on. */
interface Target {
  readonly machine: Machine
  readonly listed: Listed
  readonly known: Option.Option<Known>
}

const same = (one: string, other: string) => one.trim().toLowerCase() === other.trim().toLowerCase()

const stamp = (millis: number) => new Date(millis).toISOString()

const newest = (project: Catalog["projects"][number]) =>
  Math.max(0, ...project.recent.map(({ date }) => Date.parse(date)).filter((at) => !Number.isNaN(at)))

/**
 * What to start and where, from a decision, checked against what's there: a
 * model can name what doesn't exist. A project that doesn't is asked about, and
 * anything else falls back on what the project last used.
 */
export const resolve = (
  machines: ReadonlyArray<Machine>,
  listings: ReadonlyArray<Listing>,
  decision: Pick<Decision, "about" | "project" | "machine" | "model" | "effort" | "worktree" | "worktreeFrom" | "branch" | "prompt">,
): Either.Either<Resolved, string> => {
  const found = listings.flatMap((listing) =>
    Option.match(listing.catalog, {
      onNone: () => [],
      onSome: (catalog) =>
        catalog.projects
          .filter(({ name }) => same(name, decision.project))
          .map((project) => ({ project, catalog, machine: machines.find(({ name }) => name === listing.machine) })),
    }),
  )
  const named = found.filter(({ machine }) => machine !== undefined && same(machine.name, decision.machine))
  // Where it was worked on last, when the machine wasn't said or doesn't have it.
  const [place] = (named.length > 0 ? named : found).toSorted((one, other) => newest(other.project) - newest(one.project))
  if (decision.project.trim() === "" || place?.machine === undefined) {
    return Either.left(`Which project is ${decision.about.trim() || "that"} for?`)
  }
  const { project, catalog, machine } = place
  const known = (wanted: string) =>
    catalog.models.find(({ name, title, aliases }) => [name, title, ...aliases].some((other) => same(other, wanted)))
  const model = known(decision.model) ?? (project.model === undefined ? undefined : known(project.model.name))
  const effort = [decision.effort, ...(model?.name === project.model?.name ? [project.model?.effort ?? ""] : [])].find(
    (effort) => effort !== "" && model?.efforts.some((offered) => same(offered, effort)),
  )
  return Either.right({
    unsure: decision.worktreeFrom === "unclear",
    machine,
    project,
    catalog,
    request: {
      // Its path, since two projects can share a name.
      project: project.path,
      prompt: decision.prompt.trim(),
      ...(model === undefined ? {} : { model: model.name }),
      ...(effort === undefined ? {} : { effort: effort.toLowerCase() }),
      worktree: decision.worktree && project.repository,
      ...(decision.branch.trim() === "" ? {} : { baseBranch: decision.branch.trim() }),
    },
  })
}

/**
 * What's said once it started. The writer's own words when they match what
 * started, since it says names the way people do. Otherwise the plain facts,
 * with what the launcher had to add.
 */
export const confirmation = (spoken: string, { unsure, machine, project, catalog, request }: Resolved, started: Started) => {
  const asked = started.worktree === request.worktree && (request.model === undefined || same(request.model, started.model))
  const title = catalog.models.find(({ name }) => same(name, started.model))?.title ?? started.model
  const where = started.worktree ? "in a worktree" : "without a worktree"
  const plain = `Started in ${project.name}${machine.here ? "" : ` on ${machine.name}`}, on ${title}, ${where}.`
  const said = asked && spoken.trim() !== "" ? spoken.trim() : plain
  return [
    said,
    // It's how they catch a worktree that was misheard, so it's never left to the writer alone.
    ...(/work\s?-?tree/i.test(said) ? [] : [`That's ${where}.`]),
    ...(unsure ? [`I couldn't tell whether you wanted a worktree, so I went by your rules.`] : []),
    ...(started.warning === undefined ? [] : [started.warning]),
  ].join(" ")
}

/** Who a message or a summary is about, the way it's said: the project when T3 Code names one, and the machine only when it isn't this one. */
const recipient = ({ machine, listed }: Target) =>
  `${listed.title}${listed.project.trim() === "" ? "" : ` in ${listed.project}`}${machine.here ? "" : ` on ${machine.name}`}`

/**
 * What's said of how a message went. Only what couldn't be told needs the
 * user: a held message is on its way, and they'll hear when it got there.
 */
const delivered = (to: string, delivery: Delivery): { readonly spoken: string; readonly priority: Notice["priority"] } => {
  switch (delivery._tag) {
    case "Sent":
      return { spoken: `Sent to ${to}.`, priority: "done" }
    case "Held":
      return { spoken: `${to} is in the middle of a turn, so I'll pass it on when it finishes.`, priority: "done" }
    case "Pending":
      return {
        spoken: [`I couldn't tell whether that reached ${to}:`, delivery.reason.trim(), "I'll keep trying, and it won't arrive twice."].filter(Boolean).join(" "),
        priority: "needs-you",
      }
  }
}

/**
 * What was asked for when the shortcut was pressed, kept while it's fresh
 * enough, and asked for again when it isn't, like when a dictation is sent
 * long after.
 */
const keep = <A>(fetch: Effect.Effect<A>, fresh: number, scope: Scope.Scope) => {
  let fetched: { readonly at: number; readonly fiber: Fiber.RuntimeFiber<A> } | undefined
  const refresh = Effect.gen(function* () {
    const at = yield* Clock.currentTimeMillis
    const fiber = yield* Effect.forkIn(fetch, scope)
    fetched = { at, fiber }
    return fiber
  })
  const get = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    return yield* Fiber.join(fetched !== undefined && now - fetched.at < fresh ? fetched.fiber : yield* refresh)
  })
  return { refresh: Effect.asVoid(refresh), get }
}

export const make = (options: {
  readonly machines: ReadonlyArray<Machine>
  /** The user's rules, read as they are now. */
  readonly rules: Effect.Effect<Option.Option<string>>
  /** What the user was told lately, newest first. */
  readonly recent: Effect.Effect<ReadonlyArray<Heard>>
  readonly note: (heard: Heard) => Effect.Effect<void>
  /** Queues something to say. */
  readonly tell: (notice: Notice) => Effect.Effect<void>
  /** What yapd knows of threads themselves. */
  readonly records: Records
  /** Where every message for a thread goes. */
  readonly outbox: Outbox
  /** Says which names there are, for what transcribes the dictation that's under way. */
  readonly expect?: (terms: ReadonlyArray<string>) => Effect.Effect<void>
}) =>
  Effect.gen(function* () {
    const writer = yield* Writer
    const reporter = yield* Reporter
    const scope = yield* Effect.scope
    const writing = yield* Effect.makeSemaphore(writers)
    const drafts = new Map<string, Draft>()
    const research = options.machines.some(({ researcher }) => researcher.available)

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...drafts.values()].filter(({ open }) => open),
        (draft) =>
          Effect.logWarning(
            draft.starting
              ? `yapd stopped as this was being acted on, so check whether it was before dictating it again: ${draft.heard}`
              : `Dropped as yapd stopped, so dictate it again: ${draft.heard}`,
          ).pipe(Effect.annotateLogs({ draft: draft.id })),
        { discard: true },
      ),
    )

    const background = <A, E>(effect: Effect.Effect<A, E>, draft: Draft) =>
      effect.pipe(
        Effect.catchAllCause((cause) =>
          Cause.isInterruptedOnly(cause) ? Effect.void : Effect.logError("Could not act on what was dictated", cause),
        ),
        Effect.annotateLogs({ draft: draft.id }),
        Effect.forkIn(scope),
        Effect.asVoid,
      )

    const listing = (machine: Machine) =>
      machine.launcher.catalog.pipe(
        Effect.timeoutFail({ duration: patience, onTimeout: () => new LaunchError({ reason: `${machine.name} isn't answering.` }) }),
        Effect.match({
          onSuccess: (catalog): Listing => ({ machine: machine.name, here: machine.here, hosts: machine.hosts, catalog: Option.some(catalog) }),
          onFailure: ({ reason }): Listing => ({ machine: machine.name, here: machine.here, hosts: machine.hosts, catalog: Option.none(), reason }),
        }),
      )

    /** A machine's threads, with what yapd knows of each. What it can't recall is only logged: the listing is still worth having. */
    const threadListing = (machine: Machine) =>
      Effect.gen(function* () {
        const listed = yield* machine.threads.list.pipe(
          Effect.timeoutFail({ duration: patience, onTimeout: () => new ThreadsError({ reason: `${machine.name} isn't answering.` }) }),
          Effect.either,
        )
        if (Either.isLeft(listed)) {
          return { machine: machine.name, here: machine.here, threads: [], reason: listed.left.reason } satisfies ThreadListing
        }
        const known = yield* options.records.recall(machine.name, listed.right.map(({ id }) => id)).pipe(
          Effect.catchAll((error) =>
            Effect.logWarning(`Couldn't recall what's known of the threads on ${machine.name}`, error).pipe(Effect.as(new Map<string, Known>())),
          ),
        )
        return {
          machine: machine.name,
          here: machine.here,
          threads: listed.right.map((listed) => ({ listed, known: Option.fromNullable(known.get(listed.id)) })),
        } satisfies ThreadListing
      })

    /** Threads whose first message is being fetched, so a listing that comes while it is doesn't fetch it again. */
    const learning = new Set<string>()
    /** When a thread's first message was last asked for and not had, so listings every minute don't ask again and again for one that can't be given. */
    const unlearnt = new Map<string, number>()
    /**
     * A thread yapd didn't start is known by its first message, fetched once
     * and kept, so that later dictations can tell it by what the work is.
     * Only the threads the writer would be shown, in the background: no draft
     * waits on it, and what can't be fetched is only logged, and not asked for
     * again for a while.
     */
    const learn = (threads: ReadonlyArray<ThreadListing>) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const missing = shortlist(threads, now).flatMap(({ machine: name, threads }) =>
          threads
            .filter(({ known }) => Option.isNone(known) || known.value.prompt === null)
            .flatMap(({ listed }) => {
              const machine = options.machines.find((machine) => machine.name === name)
              const id = key(name, listed.id)
              const tried = unlearnt.get(id)
              return machine === undefined || learning.has(id) || (tried !== undefined && now - tried < relearn) ? [] : [{ machine, id: listed.id }]
            }),
        )
        for (const { machine, id } of missing) learning.add(key(machine.name, id))
        yield* Effect.forEach(
          missing,
          ({ machine, id }) =>
            machine.threads.opening(id).pipe(
              // A whole thread is read for it, over SSH for another machine, and a read that hangs would keep the thread from ever being learnt.
              Effect.timeoutFail({ duration: reading, onTimeout: () => new ThreadsError({ reason: `${machine.name} isn't answering.` }) }),
              Effect.flatMap((prompt) =>
                options.records.remember({ machine: machine.name, id, prompt, dictated: null, description: null, started: false, at: stamp(now) }),
              ),
              Effect.tap(() => Effect.sync(() => unlearnt.delete(key(machine.name, id)))),
              Effect.catchAll((error) =>
                Effect.zipRight(
                  Effect.logWarning(`Couldn't learn what ${key(machine.name, id)} started as`, error),
                  Effect.map(Clock.currentTimeMillis, (at) => void unlearnt.set(key(machine.name, id), at)),
                ),
              ),
              Effect.ensuring(Effect.sync(() => learning.delete(key(machine.name, id)))),
            ),
          { concurrency: learners, discard: true },
        ).pipe(Effect.forkIn(scope))
      })

    /** Asks every machine at once what it can start, and what threads it has. */
    const catalogs = keep(
      Effect.forEach(options.machines, listing, { concurrency: "unbounded" }).pipe(
        Effect.tap((listings) => options.expect?.(vocabulary(listings)) ?? Effect.void),
      ),
      fresh,
      scope,
    )
    const threads = keep(Effect.forEach(options.machines, threadListing, { concurrency: "unbounded" }).pipe(Effect.tap(learn)), freshThreads, scope)

    const close = (draft: Draft) =>
      Effect.sync(() => {
        draft.open = false
        drafts.delete(draft.id)
      })

    const say = (draft: Draft, spoken: string, priority: Notice["priority"], extra: Partial<Notice> = {}) =>
      options.tell({
        id: `draft:${draft.id}:${crypto.randomUUID()}`,
        priority,
        spoken,
        at: draft.at,
        stale: Effect.succeed(false),
        ...extra,
      })

    /** Nothing done, and the user hears why. */
    const fail = (draft: Draft, reason: string) =>
      Effect.gen(function* () {
        yield* close(draft)
        yield* Effect.logWarning(`Nothing done: ${reason}`)
        yield* say(draft, draft.about === "" ? reason : `About ${draft.about}: ${reason}`, "needs-you")
      })

    /** Once more if it fails, as with summaries. */
    const decide = (material: Material) => writer.decide(material).pipe(Effect.retry({ times: 1 }), writing.withPermits(1))

    /** What the user said, over the whole exchange, for a question to be answered from. */
    const asked = (draft: Draft) =>
      draft.lines
        .filter(({ speaker }) => speaker === "user")
        .map(({ text }) => text)
        .join(" ")

    const start = (draft: Draft, resolved: Resolved, spoken: string, why: string, description: string, warning?: string) =>
      Effect.gen(function* () {
        const { machine, project, request } = resolved
        if (request.prompt === "") return yield* fail(draft, "I couldn't write that up, so nothing started.")
        yield* Effect.logInfo(
          `Decided: ${project.name} on ${machine.name}, ${[request.model ?? "its usual model", request.effort].filter(Boolean).join(" ")}, ${
            request.worktree === true ? "in a worktree" : "without a worktree"
          }${request.baseBranch === undefined ? "" : ` from ${request.baseBranch}`}. ${why}`,
        )
        yield* Effect.logInfo(`Prompt: ${request.prompt}`)
        draft.starting = true
        const outcome = yield* Effect.either(machine.launcher.start(request))
        if (Either.isLeft(outcome)) {
          yield* Effect.logWarning("Could not start", outcome.left)
          return yield* fail(draft, outcome.left.reason)
        }
        const started = outcome.right
        const now = yield* Clock.currentTimeMillis
        yield* close(draft)
        yield* Effect.logInfo(`Started ${started.thread} in ${started.directory}, ${((now - draft.at) / 1000).toFixed(1)} s after it was dictated`)
        // Kept to know the thread by later. The start stands whether or not it could be.
        yield* options.records
          .remember({
            machine: machine.name,
            id: started.thread,
            prompt: request.prompt,
            dictated: asked(draft),
            description: description.trim() || null,
            started: true,
            at: stamp(now),
          })
          .pipe(Effect.catchAll((error) => Effect.logWarning(`Couldn't keep what ${started.thread} is about`, error)))
        const said = [confirmation(spoken, resolved, started), warning].filter(Boolean).join(" ")
        yield* options.note({
          project: project.name,
          ...(machine.hosts[0] === undefined ? {} : { host: machine.hosts[0] }),
          directory: started.directory,
          spoken: said,
          message: request.prompt,
          started: true,
          thread: { machine: machine.name, id: started.thread },
          at: now,
        })
        yield* say(draft, said, "done")
      })

    const offer = (draft: Draft, material: Material, question: string): Effect.Effect<void> =>
      say(draft, question, "needs-you", {
        stale: Effect.sync(() => !draft.open),
        question: {
          answer: (heard) => answer(draft, material, heard),
          unanswered: Effect.suspend(() => {
            draft.unanswered++
            if (draft.unanswered < asks) {
              return background(Effect.zipRight(Effect.sleep(again), offer(draft, material, question)), draft)
            }
            draft.open = false
            return background(
              Effect.gen(function* () {
                yield* close(draft)
                yield* Effect.logWarning(`Dropped, since "${question}" went unanswered: ${draft.heard}`)
                yield* say(draft, `I didn't hear back about ${draft.about || "what you dictated"}, so I dropped it.`, "done")
              }),
              draft,
            )
          }),
        },
      })

    const ask = (draft: Draft, material: Material, question: string) =>
      Effect.gen(function* () {
        draft.lines.push({ speaker: "yapd", text: question })
        draft.unanswered = 0
        yield* Effect.logInfo(`Asked: ${question}`)
        yield* offer(draft, material, question)
      })

    /** What they said after a question, worked out but not acted on, since they may still be talking. */
    const answer = (draft: Draft, material: Material, heard: string) =>
      decide({ ...material, lines: [...draft.lines, { speaker: "user", text: heard }] }).pipe(
        Effect.map((decision) =>
          decision.action === "wait"
            ? Option.none()
            : Option.some(
                Effect.suspend(() => {
                  draft.lines.push({ speaker: "user", text: heard })
                  return background(
                    Effect.zipRight(Effect.logInfo(`Answered: ${heard}`), act(draft, { ...material, lines: [...draft.lines] }, decision)),
                    draft,
                  )
                }),
              ),
        ),
        Effect.catchAll((error) => Effect.logWarning("Could not work out the answer", error).pipe(Effect.as(Option.none()))),
        Effect.annotateLogs({ draft: draft.id }),
      )

    const look = (draft: Draft, material: Material, resolved: Resolved, decision: Decision) =>
      Effect.gen(function* () {
        const { machine, project, request } = resolved
        let looking = true
        yield* Effect.logInfo(`Reading through ${project.name} on ${machine.name} first: ${decision.prompt}. ${decision.why}`)
        // Said before anything is read, and not at all once there's something better to say.
        yield* say(draft, decision.spoken.trim() || `Looking through ${project.name} first.`, "needs-you", {
          stale: Effect.sync(() => !looking),
        })
        const destination: Destination = {
          about: draft.about,
          project: project.name,
          machine: machine.here ? "" : machine.name,
          directory: project.path,
          model: request.model ?? "",
          effort: request.effort ?? "",
          worktree: request.worktree === true,
          lookFor: decision.prompt,
        }
        const written = yield* writer.research(material, destination, machine.researcher).pipe(
          writing.withPermits(1),
          Effect.either,
          Effect.ensuring(
            Effect.sync(() => {
              looking = false
            }),
          ),
        )
        if (Either.isRight(written)) {
          if (written.right.action === "ask") return yield* ask(draft, material, written.right.spoken)
          const prompt = written.right.prompt
          return yield* start(draft, { ...resolved, request: { ...request, prompt } }, written.right.spoken, written.right.why, decision.description)
        }
        // Written from what they said after all, which leaves what was to be looked up to the agent.
        yield* Effect.logWarning(`Could not read through ${project.name}, so it's written without`, written.left)
        const blind = yield* decide({ ...material, research: false })
        return yield* act(draft, { ...material, research: false }, blind, "I couldn't read through it first.")
      })

    /**
     * The thread a message or a question is about, when the user's own words
     * settle it and it's one that was listed. Anything less is a guess, and a
     * message to the wrong agent is the costly mistake.
     */
    const target = (material: Material, decision: Decision): Option.Option<Target> => {
      if (!groundedThread(decision, material.lines, material.threads, material.recent)) return Option.none()
      return Option.flatMap(parseKey(decision.thread.trim()), ({ machine: name, id }) => {
        const machine = options.machines.find((machine) => machine.name === name)
        const found = material.threads.find((listing) => listing.machine === name)?.threads.find(({ listed }) => listed.id === id)
        return machine === undefined || found === undefined ? Option.none() : Option.some({ machine, listed: found.listed, known: found.known })
      })
    }

    /** Asks which thread, in the writer's words when it asked one, else plainly. */
    const unsettled = (draft: Draft, material: Material, decision: Decision, plain: string) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(
          `Asking, since the thread "${decision.thread}" was ${
            decision.threadFrom === "unclear" ? "unclear" : `${decision.threadFrom} by "${decision.threadEvidence}", which doesn't settle it`
          }. ${decision.why}`,
        )
        const spoken = decision.spoken.trim()
        return yield* ask(draft, material, spoken.endsWith("?") ? spoken : plain)
      })

    const message = (draft: Draft, material: Material, decision: Decision) =>
      Effect.gen(function* () {
        const found = target(material, decision)
        if (Option.isNone(found)) return yield* unsettled(draft, material, decision, "Which thread is that for?")
        const { machine, listed } = found.value
        const to = recipient(found.value)
        const text = decision.prompt.trim()
        if (text === "") return yield* ask(draft, material, `What should I tell ${listed.title}?`)
        yield* Effect.logInfo(`Message for ${key(machine.name, listed.id)}, ${to}: ${text}. ${decision.why}`)
        draft.starting = true
        const outcome = yield* Effect.either(options.outbox.send(machine.name, listed, text))
        if (Either.isLeft(outcome)) {
          yield* Effect.logWarning("Could not send", outcome.left)
          return yield* fail(draft, `I couldn't send that to ${to}. ${outcome.left._tag === "ThreadsError" ? outcome.left.reason : outcome.left.message}`)
        }
        const now = yield* Clock.currentTimeMillis
        yield* close(draft)
        const said = delivered(to, outcome.right)
        // Noted whether it went or is still on its way: either way the user can build on it.
        yield* options.note({
          project: listed.project,
          ...(machine.hosts[0] === undefined ? {} : { host: machine.hosts[0] }),
          directory: listed.directory,
          spoken: said.spoken,
          message: text,
          thread: { machine: machine.name, id: listed.id },
          at: now,
        })
        yield* say(draft, said.spoken, said.priority)
      })

    const summary = (draft: Draft, material: Material, decision: Decision) =>
      Effect.gen(function* () {
        const found = target(material, decision)
        if (Option.isNone(found)) return yield* unsettled(draft, material, decision, "Which thread do you mean?")
        const { machine, listed, known } = found.value
        const to = recipient(found.value)
        yield* Effect.logInfo(`Summing up ${key(machine.name, listed.id)}, ${to}. ${decision.why}`)
        const detail = yield* Effect.either(machine.threads.detail(listed.id, turns))
        if (Either.isLeft(detail)) {
          yield* Effect.logWarning("Could not read the thread", detail.left)
          return yield* fail(draft, `I couldn't read ${to}. ${detail.left.reason}`)
        }
        const now = yield* Clock.currentTimeMillis
        const report = yield* Effect.either(reporter.summarize({ question: asked(draft), machine: machine.name, here: machine.here, detail: detail.right, known, now }))
        if (Either.isLeft(report)) {
          yield* Effect.logWarning("Could not sum up the thread", report.left)
          return yield* fail(draft, `I couldn't sum up ${to} right now.`)
        }
        yield* close(draft)
        const { thread, messages } = detail.right
        // What was read out carries the thread, so "tell it to" can follow.
        yield* options.note({
          project: thread.project,
          ...(machine.hosts[0] === undefined ? {} : { host: machine.hosts[0] }),
          directory: thread.directory,
          spoken: report.right.spoken,
          message: messages.findLast(({ role }) => role === "assistant")?.text ?? "",
          thread: { machine: machine.name, id: thread.id },
          at: now,
        })
        yield* say(draft, report.right.spoken, thread.state === "waiting" || thread.state === "failed" ? "needs-you" : "done")
      })

    const status = (draft: Draft, material: Material, decision: Decision) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`Reporting across the threads. ${decision.why}`)
        // From a listing that's fresh, not the one the request was worked out from: an answer can come
        // minutes after a question, and "who needs me" is about now.
        const listed = yield* threads.get
        const now = yield* Clock.currentTimeMillis
        const report = yield* Effect.either(reporter.report({ question: asked(draft), threads: listed, now }))
        if (Either.isLeft(report)) {
          yield* Effect.logWarning("Could not report", report.left)
          return yield* fail(draft, "I couldn't check on your threads right now.")
        }
        yield* close(draft)
        yield* say(draft, report.right.spoken, "done")
      })

    const act = (draft: Draft, material: Material, decision: Decision, warning?: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (decision.about.trim() !== "") draft.about = decision.about.trim()
        switch (decision.action) {
          case "ask":
            return yield* ask(draft, material, decision.spoken.trim() || `Which project is ${draft.about || "that"} for?`)
          case "message":
            return yield* message(draft, material, decision)
          case "summary":
            return yield* summary(draft, material, decision)
          case "status":
            return yield* status(draft, material, decision)
          case "start":
          case "research": {
            // Only new work needs somewhere to start.
            if (!material.listings.some(({ catalog }) => Option.isSome(catalog))) {
              const reason = (material.listings.find(({ here }) => here) ?? material.listings[0])?.reason
              return yield* fail(draft, reason ?? "There's nowhere to start new work right now.")
            }
            // Whatever the writer went on to decide, a project it couldn't say why it chose is a guess.
            if (!grounded(decision, material.lines)) {
              yield* Effect.logInfo(
                `Asking, since "${decision.project}" was ${decision.settled === "unclear" ? "unclear" : `${decision.settled} by "${decision.evidence}", which they didn't say`}. ${decision.why}`,
              )
              return yield* ask(draft, material, `Which project is ${draft.about || "that"} for?`)
            }
            const resolved = resolve(options.machines, material.listings, decision)
            if (Either.isLeft(resolved)) {
              yield* Effect.logInfo(`Decided on "${decision.project}", which isn't a project anywhere. ${decision.why}`)
              return yield* ask(draft, material, resolved.left)
            }
            return decision.action === "start"
              ? yield* start(draft, resolved.right, decision.spoken, decision.why, decision.description, warning)
              : yield* look(draft, material, resolved.right, decision)
          }
          case "none":
          case "drop":
          // Not an answer to anything, when there was no question.
          case "wait": {
            yield* close(draft)
            yield* Effect.logInfo(`${decision.action === "drop" ? "Dropped" : "Nothing to do"}. ${decision.why}`)
            const spoken = decision.spoken.trim() || (decision.action === "drop" ? "Dropped." : "That didn't sound like anything for me, so I left it.")
            return yield* say(draft, spoken, "done")
          }
        }
      }).pipe(
        Effect.catchAll((error) =>
          Effect.logWarning("Could not act on what was dictated", error).pipe(
            Effect.zipRight(fail(draft, "I couldn't work that out, so nothing was done. What you said is in my log.")),
          ),
        ),
      )

    const write = (draft: Draft) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`Dictated: ${draft.heard}`)
        const [listings, listed] = yield* Effect.all([catalogs.get, threads.get], { concurrency: "unbounded" })
        // Without a project to start in or a thread to talk to, there's nothing a dictation can be for.
        if (listings.every(({ catalog }) => Option.isNone(catalog)) && listed.every(({ reason }) => reason !== undefined)) {
          const reason = (listings.find(({ here }) => here) ?? listings[0])?.reason
          return yield* fail(draft, reason ?? "There's nowhere to start work, and no threads I can reach.")
        }
        const material: Material = {
          listings,
          threads: listed,
          rules: yield* options.rules,
          recent: yield* options.recent,
          earlier: [...drafts.values()].filter((other) => other.open && other.at <= draft.at && other !== draft).map(({ heard }) => heard),
          lines: [...draft.lines],
          research,
          now: yield* Clock.currentTimeMillis,
        }
        const decision = yield* decide(material).pipe(
          Effect.catchAll((error) =>
            Effect.logWarning("Could not work out what was dictated", error).pipe(
              Effect.zipRight(fail(draft, "I couldn't work that out, so nothing was done. What you said is in my log.")),
              Effect.as(undefined),
            ),
          ),
        )
        if (decision !== undefined) yield* act(draft, material, decision)
      })

    return {
      /** The user started dictating: what's ready by the time they've finished doesn't hold the prompt up. */
      prepare: Effect.all([catalogs.refresh, threads.refresh, writer.prepare], { discard: true }),
      /** Takes what the user dictated, and returns at once. */
      dictated: (heard: string) =>
        Effect.gen(function* () {
          const draft: Draft = {
            id: crypto.randomUUID().slice(0, 8),
            heard,
            at: yield* Clock.currentTimeMillis,
            lines: [{ speaker: "user", text: heard }],
            about: "",
            unanswered: 0,
            starting: false,
            open: true,
          }
          drafts.set(draft.id, draft)
          yield* background(write(draft), draft)
        }),
    }
  })
