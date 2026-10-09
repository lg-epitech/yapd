import { Clock, type Duration, Effect, Either, Fiber, Option } from "effect"
import { type Catalog, LaunchError, type Launcher, type Request, type Started } from "./Launcher.ts"
import { afterOnIt, type Lines, Persona, withOnIt } from "./Persona.ts"
import type { Heard } from "./Recent.ts"
import type { Researcher } from "./Research.ts"
import type { Line } from "./Responder.ts"
import { type Decision, type Destination, grounded, type Listing, type Material, vocabulary, Writer } from "./Writer.ts"

// New work, from what the user said to where it starts: the writer decides
// where it goes and writes the prompt, which is checked against what's there
// and started. Whether what they said is new work at all, and what to ask
// them, is for whoever heard it; this only says what came of it.

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
/** Prompts being written at once. */
const writers = 3

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
 * started, since it says names the way people do, after the line for going
 * ahead, `lines.onIt`, which they leave to yapd. Otherwise the plain facts,
 * with what the launcher had to add.
 */
export const confirmation = (
  spoken: string,
  { unsure, machine, project, catalog, request }: Resolved,
  started: Started,
  lines: Pick<Lines, "onIt" | "address">,
) => {
  const asked = started.worktree === request.worktree && (request.model === undefined || same(request.model, started.model))
  const title = catalog.models.find(({ name }) => same(name, started.model))?.title ?? started.model
  const where = started.worktree ? "in a worktree" : "without a worktree"
  const plain = `Started in ${project.name}${machine.here ? "" : ` on ${machine.name}`}, on ${title}, ${where}.`
  // An "On it" the writer put in front anyway goes, since the line for going ahead takes its place, and with only that there are no words of its own.
  const words = afterOnIt(spoken, lines)
  const said = asked && words !== "" ? withOnIt(lines.onIt, words) : plain
  return [
    said,
    // It's how they catch a worktree that was misheard, so it's never left to the writer alone.
    ...(/work\s?-?tree/i.test(said) ? [] : [`That's ${where}.`]),
    ...(unsure ? [`I couldn't tell whether you wanted a worktree, so I went by your rules.`] : []),
    ...(started.warning === undefined ? [] : [started.warning]),
  ].join(" ")
}

/** What the writer made of a request, with what it went by, ready to act on. */
export interface Written {
  readonly decision: Decision
  readonly material: Material
}

/** What became of new work. */
export type Outcome =
  | {
      readonly _tag: "Started"
      readonly spoken: string
      readonly started: Started
      readonly machine: Machine
      readonly request: Request
      /** The request in a few words. */
      readonly about: string
    }
  /** Which project it's for has to be asked, and the material kept for the answer. */
  | { readonly _tag: "Asked"; readonly question: string; readonly about: string; readonly material: Material }
  /** The project is being read through first, which takes a while: `then` is what comes of it. */
  | {
      readonly _tag: "Looking"
      readonly spoken: string
      readonly about: string
      readonly project: string
      readonly machine: Machine
      readonly then: Effect.Effect<Outcome>
    }
  /** It was asked for, and T3 Code is getting it ready, which takes minutes for a worktree: `then` is what comes of it, which can be waited for more than once. */
  | { readonly _tag: "Launching"; readonly about: string; readonly project: string; readonly machine: Machine; readonly then: Effect.Effect<Outcome> }
  /** Nothing started, and this says why, or that there was nothing to start. */
  | { readonly _tag: "Said"; readonly spoken: string; readonly failed: boolean }

/** Notes work as it starts, in the same breath, so nothing can come between the two. */
export type Noted = (started: Extract<Outcome, { readonly _tag: "Started" }>) => Effect.Effect<void>

/** What's said when the prompt couldn't be written. */
export const unwritten = "I couldn't write that up, so nothing started. What you said is in my log."

/** Starts new work on the machines there are, with the user's rules and what they heard lately to go by. */
export const make = (options: {
  readonly machines: ReadonlyArray<Machine>
  /** The user's rules, read as they are now. */
  readonly rules: Effect.Effect<Option.Option<string>>
  /** What the user was told lately, newest first. */
  readonly recent: Effect.Effect<ReadonlyArray<Heard>>
  /** Says which names there are, for what transcribes the dictation that's under way. */
  readonly expect?: (terms: ReadonlyArray<string>) => Effect.Effect<void>
}) =>
  Effect.gen(function* () {
    const writer = yield* Writer
    const persona = yield* Persona
    const scope = yield* Effect.scope
    const writing = yield* Effect.makeSemaphore(writers)
    const research = options.machines.some(({ researcher }) => researcher.available)

    const listing = (machine: Machine) =>
      machine.launcher.catalog.pipe(
        Effect.timeoutFail({ duration: patience, onTimeout: () => new LaunchError({ reason: `${machine.name} isn't answering.` }) }),
        Effect.match({
          onSuccess: (catalog): Listing => ({ machine: machine.name, here: machine.here, hosts: machine.hosts, catalog: Option.some(catalog) }),
          onFailure: ({ reason }): Listing => ({ machine: machine.name, here: machine.here, hosts: machine.hosts, catalog: Option.none(), reason }),
        }),
      )

    let fetched: { readonly at: number; readonly fiber: Fiber.RuntimeFiber<Array<Listing>> } | undefined
    /** Asks every machine at once what it can start, telling what transcribes the dictation which names there are. */
    const fetch = (titles: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        const fiber = yield* Effect.forEach(options.machines, listing, { concurrency: "unbounded" }).pipe(
          Effect.tap((listings) => options.expect?.(vocabulary(listings, titles)) ?? Effect.void),
          Effect.forkIn(scope),
        )
        fetched = { at, fiber }
        return fiber
      })
    /** What was asked for when the shortcut was pressed, which is usually there by now. */
    const listings = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      return yield* Fiber.join(fetched !== undefined && now - fetched.at < fresh ? fetched.fiber : yield* fetch([]))
    })

    /** Once more if it fails, as with summaries. */
    const decide = (material: Material) => writer.decide(material).pipe(Effect.retry({ times: 1 }), writing.withPermits(1))

    /**
     * Starts it, and says what started, or why nothing did. Once it's asked
     * for, it's started and noted whatever happens meanwhile, like yapd being
     * turned off: cut off halfway, a launch could leave a thread half made. So
     * it goes on by itself, and whoever asked for it waits for what comes of
     * it in its own time. It's never made uninterruptible, since then its own
     * time limits couldn't end it, and a launch that never answered would go
     * on for good.
     */
    const launch = (resolved: Resolved, spoken: string, why: string, about: string, noted: Noted, warning?: string) =>
      Effect.gen(function* () {
        const { machine, project, request } = resolved
        if (request.prompt === "") return { _tag: "Said", spoken: unwritten, failed: true } satisfies Outcome
        yield* Effect.logInfo(
          `Decided: ${project.name} on ${machine.name}, ${[request.model ?? "its usual model", request.effort].filter(Boolean).join(" ")}, ${
            request.worktree === true ? "in a worktree" : "without a worktree"
          }${request.baseBranch === undefined ? "" : ` from ${request.baseBranch}`}. ${why}`,
        )
        yield* Effect.logInfo(`Prompt: ${request.prompt}`)
        const launching = yield* Effect.gen(function* () {
          const outcome = yield* Effect.either(machine.launcher.start(request))
          if (Either.isLeft(outcome)) {
            yield* Effect.logWarning("Could not start", outcome.left)
            return { _tag: "Said", spoken: about === "" ? outcome.left.reason : `About ${about}: ${outcome.left.reason}`, failed: true } satisfies Outcome
          }
          const started = outcome.right
          yield* Effect.logInfo(`Started ${started.thread} in ${started.directory}`)
          // Picked as it's about to be said, and noted as heard by whoever says it, once it is.
          const lines = { ...(yield* persona.lines), onIt: yield* persona.onIt() }
          const begun = {
            _tag: "Started",
            spoken: [confirmation(spoken, resolved, started, lines), warning].filter(Boolean).join(" "),
            started,
            machine,
            request,
            about,
          } satisfies Outcome
          yield* noted(begun)
          return begun
        }).pipe(Effect.interruptible, Effect.forkIn(scope))
        return { _tag: "Launching", about, project: project.name, machine, then: Fiber.join(launching) } satisfies Outcome
      })

    /** Reads through the project before writing the prompt, for a request that leans on something in it. */
    const look = (material: Material, resolved: Resolved, decision: Decision, noted: Noted): Effect.Effect<Outcome> =>
      Effect.gen(function* () {
        const { machine, project, request } = resolved
        const about = decision.about.trim()
        yield* Effect.logInfo(`Reading through ${project.name} on ${machine.name} first: ${decision.prompt}. ${decision.why}`)
        const destination: Destination = {
          about,
          project: project.name,
          machine: machine.here ? "" : machine.name,
          directory: project.path,
          model: request.model ?? "",
          effort: request.effort ?? "",
          worktree: request.worktree === true,
          lookFor: decision.prompt,
        }
        const written = yield* writer.research(material, destination, machine.researcher).pipe(writing.withPermits(1), Effect.either)
        if (Either.isRight(written)) {
          if (written.right.action === "ask") return { _tag: "Asked", question: written.right.spoken, about, material } satisfies Outcome
          const prompt = written.right.prompt
          return yield* launch({ ...resolved, request: { ...request, prompt } }, written.right.spoken, written.right.why, about, noted)
        }
        // Written from what they said after all, which leaves what was to be looked up to the agent.
        yield* Effect.logWarning(`Could not read through ${project.name}, so it's written without`, written.left)
        const plain = { ...material, research: false }
        const blind = yield* decide(plain).pipe(Effect.either)
        if (Either.isLeft(blind)) return { _tag: "Said", spoken: unwritten, failed: true } satisfies Outcome
        return yield* start({ decision: blind.right, material: plain }, noted, "I couldn't read through it first.")
      })

    /** Carries out what the writer decided: starts it, or says what has to be asked, or why nothing started. */
    const start = (written: Written, noted: Noted = () => Effect.void, warning?: string): Effect.Effect<Outcome> =>
      Effect.gen(function* () {
        const { decision, material } = written
        const about = decision.about.trim()
        const asking = (question: string): Outcome => ({ _tag: "Asked", question, about, material })
        switch (decision.action) {
          case "ask":
            return asking(decision.spoken.trim() || `Which project is ${about || "that"} for?`)
          case "start":
          case "research": {
            // Whatever the writer went on to decide, a project it couldn't say why it chose is a guess.
            if (!grounded(decision, material.lines)) {
              yield* Effect.logInfo(
                `Asking, since "${decision.project}" was ${decision.settled === "unclear" ? "unclear" : `${decision.settled} by "${decision.evidence}", which they didn't say`}. ${decision.why}`,
              )
              return asking(`Which project is ${about || "that"} for?`)
            }
            const resolved = resolve(options.machines, material.listings, decision)
            if (Either.isLeft(resolved)) {
              yield* Effect.logInfo(`Decided on "${decision.project}", which isn't a project anywhere. ${decision.why}`)
              return asking(resolved.left)
            }
            if (decision.action === "start") return yield* launch(resolved.right, decision.spoken, decision.why, about, noted, warning)
            const { project, machine } = resolved.right
            const spoken = decision.spoken.trim() || `Looking through ${project.name} first.`
            return { _tag: "Looking", spoken, about, project: project.name, machine, then: look(material, resolved.right, decision, noted) } satisfies Outcome
          }
          case "none":
          case "drop":
          case "wait": {
            yield* Effect.logInfo(`${decision.action === "drop" ? "Dropped" : "Nothing to start"}. ${decision.why}`)
            const spoken = decision.spoken.trim() || (decision.action === "drop" ? "Dropped." : "That didn't sound like work to start, so I left it.")
            return { _tag: "Said", spoken, failed: false } satisfies Outcome
          }
        }
      })

    return {
      /** The user started dictating: what's ready by the time they've finished doesn't hold the prompt up. */
      prepare: (titles: ReadonlyArray<string>) => Effect.zipRight(fetch(titles), writer.prepare).pipe(Effect.asVoid),
      /**
       * Writes the prompt for what was said, which may turn out not to be new
       * work: it starts before that's known, so new work doesn't wait. With
       * `answering`, the lines are an answer to the question asked about it.
       */
      begin: (lines: ReadonlyArray<Line>, answering?: Material) =>
        Effect.gen(function* () {
          const material: Material =
            answering === undefined
              ? {
                  listings: yield* listings,
                  rules: yield* options.rules,
                  recent: yield* options.recent,
                  earlier: [],
                  lines,
                  research,
                  now: yield* Clock.currentTimeMillis,
                }
              : { ...answering, lines: [...answering.lines, ...lines], now: yield* Clock.currentTimeMillis }
          if (!material.listings.some(({ catalog }) => Option.isSome(catalog))) {
            const found = material.listings
            return Either.left((found.find(({ here }) => here) ?? found[0])?.reason ?? "There's nowhere to start new work.")
          }
          return yield* decide(material).pipe(
            Effect.map((decision): Written => ({ decision, material })),
            Effect.tapError((error) => Effect.logWarning("Could not write the prompt", error)),
            Effect.mapError(() => unwritten),
            Effect.either,
          )
        }),
      start,
      look,
    }
  })

/** What starts new work. */
export type Drafts = Effect.Effect.Success<ReturnType<typeof make>>
