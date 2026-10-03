import { Cause, Clock, type Duration, Effect, Either, Fiber, Option } from "effect"
import type { Notice } from "./Inbox.ts"
import { type Catalog, LaunchError, type Launcher, type Request, type Started } from "./Launcher.ts"
import type { Heard } from "./Recent.ts"
import type { Researcher } from "./Research.ts"
import type { Line } from "./Responder.ts"
import { type Decision, type Destination, grounded, type Listing, type Material, vocabulary, Writer } from "./Writer.ts"

// What the user dictated becomes a draft: written in the background, however
// many there are, while updates keep being read. What a draft has to say, a
// question, that it's reading the project, that it started or why it didn't,
// waits for its turn like updates do, and an answer goes back to the draft that
// asked. Drafts only live in memory: what the user said is in the log from
// the start, so one that's lost can be dictated again, and none starts later
// than the user would expect it to.

/** A machine work can start on. */
export interface Machine {
  /** What the user calls it. */
  readonly name: string
  readonly here: boolean
  /** Names its hooks may report it by. */
  readonly hosts: ReadonlyArray<string>
  readonly launcher: Launcher
  readonly researcher: Researcher
}

/** How long a machine has to say what it can start, from when the shortcut is pressed. */
const patience: Duration.DurationInput = "8 seconds"
/** Catalogs older than this are fetched again, like when a dictation is sent long after the shortcut was pressed. */
const fresh = 5 * 60_000
/** How long after a question went unanswered it's asked again. */
const again: Duration.DurationInput = "1 minute"
/** How many times a question is asked before the request is dropped. */
const asks = 2
/** Prompts being written at once. */
const writers = 3

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
  /** Whether it's being started right now, which can't be taken back. */
  starting: boolean
  open: boolean
  /** Dropped, like when yapd was turned off: it says nothing, and starts nothing unless it already was. */
  dropped: boolean
  /** What's being done for it in the background, to stop when it's dropped. */
  readonly jobs: Set<Fiber.RuntimeFiber<unknown, unknown>>
}

interface Resolved {
  /** Whether what they said about a worktree could be heard either way. */
  readonly unsure: boolean
  readonly machine: Machine
  readonly project: Catalog["projects"][number]
  readonly catalog: Catalog
  readonly request: Request
}

const same = (one: string, other: string) => one.trim().toLowerCase() === other.trim().toLowerCase()

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

export const make = (options: {
  readonly machines: ReadonlyArray<Machine>
  /** The user's rules, read as they are now. */
  readonly rules: Effect.Effect<Option.Option<string>>
  /** What the user was told lately, newest first. */
  readonly recent: Effect.Effect<ReadonlyArray<Heard>>
  readonly note: (heard: Heard) => Effect.Effect<void>
  /** Queues something to say. */
  readonly tell: (notice: Notice) => Effect.Effect<void>
  /** Says which names there are, for what transcribes the dictation that's under way. */
  readonly expect?: (terms: ReadonlyArray<string>) => Effect.Effect<void>
}) =>
  Effect.gen(function* () {
    const writer = yield* Writer
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
              ? `yapd stopped as this was being started, so check whether it did before dictating it again: ${draft.heard}`
              : `Dropped as yapd stopped, so dictate it again: ${draft.heard}`,
          ).pipe(Effect.annotateLogs({ draft: draft.id })),
        { discard: true },
      ),
    )

    /** Nothing more is done for a draft once it's dropped. */
    const background = <A, E>(effect: Effect.Effect<A, E>, draft: Draft) =>
      Effect.withFiberRuntime<A | void, E>((fiber) => {
        if (draft.dropped) return Effect.void
        draft.jobs.add(fiber)
        return Effect.ensuring(effect, Effect.sync(() => draft.jobs.delete(fiber)))
      }).pipe(
        Effect.catchAllCause((cause) =>
          Cause.isInterruptedOnly(cause) ? Effect.void : Effect.logError("Could not write the prompt", cause),
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

    let fetched: { readonly at: number; readonly fiber: Fiber.RuntimeFiber<Array<Listing>> } | undefined
    /** Asks every machine at once what it can start. */
    const fetch = Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis
      const fiber = yield* Effect.forEach(options.machines, listing, { concurrency: "unbounded" }).pipe(
        Effect.tap((listings) => options.expect?.(vocabulary(listings)) ?? Effect.void),
        Effect.forkIn(scope),
      )
      fetched = { at, fiber }
      return fiber
    })
    /** What was asked for when the shortcut was pressed, which is usually there by now. */
    const listings = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      return yield* Fiber.join(fetched !== undefined && now - fetched.at < fresh ? fetched.fiber : yield* fetch)
    })

    const close = (draft: Draft) =>
      Effect.sync(() => {
        draft.open = false
        drafts.delete(draft.id)
      })

    const say = (draft: Draft, spoken: string, priority: Notice["priority"], extra: Partial<Notice> = {}) =>
      Effect.suspend(() =>
        draft.dropped
          ? Effect.void
          : options.tell({
              id: `draft:${draft.id}:${crypto.randomUUID()}`,
              priority,
              spoken,
              at: draft.at,
              stale: Effect.succeed(false),
              ...extra,
            }),
      )

    /** Nothing started, and the user hears why. */
    const fail = (draft: Draft, reason: string) =>
      Effect.gen(function* () {
        yield* close(draft)
        yield* Effect.logWarning(`Nothing started: ${reason}`)
        yield* say(draft, draft.about === "" ? reason : `About ${draft.about}: ${reason}`, "needs-you")
      })

    /** Once more if it fails, as with summaries. */
    const decide = (material: Material) => writer.decide(material).pipe(Effect.retry({ times: 1 }), writing.withPermits(1))

    const start = (draft: Draft, resolved: Resolved, spoken: string, why: string, warning?: string) =>
      Effect.gen(function* () {
        const { machine, project, request } = resolved
        if (request.prompt === "") return yield* fail(draft, "I couldn't write that up, so nothing started.")
        yield* Effect.logInfo(
          `Decided: ${project.name} on ${machine.name}, ${[request.model ?? "its usual model", request.effort].filter(Boolean).join(" ")}, ${
            request.worktree === true ? "in a worktree" : "without a worktree"
          }${request.baseBranch === undefined ? "" : ` from ${request.baseBranch}`}. ${why}`,
        )
        yield* Effect.logInfo(`Prompt: ${request.prompt}`)
        if (draft.dropped) return
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
        const said = [confirmation(spoken, resolved, started), warning].filter(Boolean).join(" ")
        yield* options.note({
          project: project.name,
          ...(machine.hosts[0] === undefined ? {} : { host: machine.hosts[0] }),
          directory: started.directory,
          spoken: said,
          message: request.prompt,
          started: true,
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
          return yield* start(draft, { ...resolved, request: { ...request, prompt } }, written.right.spoken, written.right.why)
        }
        // Written from what they said after all, which leaves what was to be looked up to the agent.
        yield* Effect.logWarning(`Could not read through ${project.name}, so it's written without`, written.left)
        const blind = yield* decide({ ...material, research: false })
        return yield* act(draft, { ...material, research: false }, blind, "I couldn't read through it first.")
      })

    const act = (draft: Draft, material: Material, decision: Decision, warning?: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (decision.about.trim() !== "") draft.about = decision.about.trim()
        switch (decision.action) {
          case "ask":
            return yield* ask(draft, material, decision.spoken.trim() || `Which project is ${draft.about || "that"} for?`)
          case "start":
          case "research": {
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
              ? yield* start(draft, resolved.right, decision.spoken, decision.why, warning)
              : yield* look(draft, material, resolved.right, decision)
          }
          case "none":
          case "drop":
          // Not an answer to anything, when there was no question.
          case "wait": {
            yield* close(draft)
            yield* Effect.logInfo(`${decision.action === "drop" ? "Dropped" : "Nothing to start"}. ${decision.why}`)
            const spoken = decision.spoken.trim() || (decision.action === "drop" ? "Dropped." : "That didn't sound like work to start, so I left it.")
            return yield* say(draft, spoken, "done")
          }
        }
      }).pipe(
        Effect.catchAll((error) =>
          Effect.logWarning("Could not write the prompt", error).pipe(
            Effect.zipRight(fail(draft, "I couldn't write that up, so nothing started. What you said is in my log.")),
          ),
        ),
      )

    const write = (draft: Draft) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(`Dictated: ${draft.heard}`)
        const found = yield* listings
        const usable = found.filter(({ catalog }) => Option.isSome(catalog))
        if (usable.length === 0) {
          return yield* fail(draft, (found.find(({ here }) => here) ?? found[0])?.reason ?? "There's nowhere to start new work.")
        }
        const material: Material = {
          listings: found,
          rules: yield* options.rules,
          recent: yield* options.recent,
          earlier: [...drafts.values()].filter((other) => other.open && other.at <= draft.at && other !== draft).map(({ heard }) => heard),
          lines: [...draft.lines],
          research,
          now: yield* Clock.currentTimeMillis,
        }
        const decision = yield* decide(material).pipe(
          Effect.catchAll((error) =>
            Effect.logWarning("Could not write the prompt", error).pipe(
              Effect.zipRight(fail(draft, "I couldn't write that up, so nothing started. What you said is in my log.")),
              Effect.as(undefined),
            ),
          ),
        )
        if (decision !== undefined) yield* act(draft, material, decision)
      })

    return {
      /**
       * Drops every request, without a word, like when yapd is turned off. One
       * being started can't be taken back, so it still starts, but says nothing.
       */
      drop: Effect.suspend(() => {
        // All at once, so none starts halfway through.
        const dropping = [...drafts.values()]
        for (const draft of dropping) draft.dropped = true
        return Effect.forEach(
          dropping,
          (draft) =>
            (draft.starting
              ? Effect.logInfo(`Starting without a word, since yapd was turned off: ${draft.heard}`)
              : Effect.forEach([...draft.jobs], Fiber.interruptFork).pipe(
                  Effect.zipRight(close(draft)),
                  Effect.zipRight(Effect.logInfo(`Dropped, since yapd was turned off: ${draft.heard}`)),
                )
            ).pipe(Effect.annotateLogs({ draft: draft.id })),
          { discard: true },
        )
      }),
      /** The user started dictating: what's ready by the time they've finished doesn't hold the prompt up. */
      prepare: Effect.zipRight(fetch, writer.prepare).pipe(Effect.asVoid),
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
            dropped: false,
            jobs: new Set(),
          }
          drafts.set(draft.id, draft)
          yield* background(write(draft), draft)
        }),
    }
  })
