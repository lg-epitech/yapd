import { Clock, type Duration, Effect, Either, Fiber, Option } from "effect"
import { type Catalog, LaunchError, type Launcher, type Request, type Started } from "./Launcher.ts"
import * as Ledger from "./Ledger.ts"
import type * as Memory from "./Memory.ts"
import { afterOnIt, type Lines, Persona, withOnIt } from "./Persona.ts"
import type { Heard } from "./Recent.ts"
import { progress, readied, unstarted } from "./T3CodeLauncher.ts"
import type * as T3Live from "./T3Live.ts"
import type { Line } from "./Words.ts"
import { type Decision, grounded, type Listing, type Material, vocabulary, Writer } from "./Writer.ts"

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

/** Whether it's T3 Code's scratch project, where work outside his projects starts. */
const scratched = (project: Catalog["projects"][number]) => project.scratch === true

/** A project as it's said and kept: the scratch project as T3 Code's own folders are, never by what T3 Code calls it. */
const called = (project: Catalog["projects"][number]) => (scratched(project) ? "scratch" : project.name)

/** What of a decision says what starts, and where. */
type Placing = Pick<Decision, "about" | "machine" | "model" | "effort" | "worktree" | "worktreeFrom" | "branch" | "prompt">

/**
 * What starts in the project it was placed in: the model and effort the
 * decision names when they're there, or else what the project last used.
 * Work outside his projects never has a worktree, nor a branch to start from.
 */
const placed = ({ project, catalog, machine }: Pick<Resolved, "project" | "catalog" | "machine">, decision: Placing): Resolved => {
  const known = (wanted: string) =>
    catalog.models.find(({ name, title, aliases }) => [name, title, ...aliases].some((other) => same(other, wanted)))
  const model = known(decision.model) ?? (project.model === undefined ? undefined : known(project.model.name))
  const effort = [decision.effort, ...(model?.name === project.model?.name ? [project.model?.effort ?? ""] : [])].find(
    (effort) => effort !== "" && model?.efforts.some((offered) => same(offered, effort)),
  )
  const outside = scratched(project)
  return {
    unsure: !outside && decision.worktreeFrom === "unclear",
    machine,
    project,
    catalog,
    request: {
      // Its path, since two projects can share a name.
      project: project.path,
      prompt: decision.prompt.trim(),
      ...(model === undefined ? {} : { model: model.name }),
      ...(effort === undefined ? {} : { effort: effort.toLowerCase() }),
      worktree: !outside && decision.worktree && project.repository,
      ...(outside || decision.branch.trim() === "" ? {} : { baseBranch: decision.branch.trim() }),
    },
  }
}

/**
 * What to start and where, from a decision, checked against what's there: a
 * model can name what doesn't exist. A project that doesn't is asked about, and
 * anything else falls back on what the project last used. The scratch project
 * is never one of his, whatever it's called.
 */
export const resolve = (
  machines: ReadonlyArray<Machine>,
  listings: ReadonlyArray<Listing>,
  decision: Placing & Pick<Decision, "project">,
): Either.Either<Resolved, string> => {
  const found = listings.flatMap((listing) =>
    Option.match(listing.catalog, {
      onNone: () => [],
      onSome: (catalog) =>
        catalog.projects
          .filter((project) => !scratched(project) && same(project.name, decision.project))
          .map((project) => ({ project, catalog, machine: machines.find(({ name }) => name === listing.machine) })),
    }),
  )
  const named = found.filter(({ machine }) => machine !== undefined && same(machine.name, decision.machine))
  // Where it was worked on last, when the machine wasn't said or doesn't have it.
  const [place] = (named.length > 0 ? named : found).toSorted((one, other) => newest(other.project) - newest(one.project))
  if (decision.project.trim() === "" || place?.machine === undefined) {
    return Either.left(`Which project is ${decision.about.trim() || "that"} for?`)
  }
  return Either.right(placed({ ...place, machine: place.machine }, decision))
}

/**
 * Where work outside his projects starts, from a decision that it belongs to
 * none: T3 Code's scratch project on the machine he said, or else this one.
 * One without it, like a machine whose yapd or T3 Code is older, is asked
 * about, as which project it's for. One that couldn't say what it can start
 * isn't: why is said instead, as there's nothing for him to answer.
 */
export const outside = (
  machines: ReadonlyArray<Machine>,
  listings: ReadonlyArray<Listing>,
  decision: Placing,
): Either.Either<Resolved, { readonly asking: boolean; readonly spoken: string }> => {
  const said = decision.machine.trim()
  const listing = listings.find(({ machine, here }) => (said === "" ? here : same(machine, said)))
  const machine = machines.find(({ name }) => name === listing?.machine)
  const catalog = Option.getOrUndefined(Option.flatMap(Option.fromNullable(listing), ({ catalog }) => catalog))
  const project = catalog?.projects.find(scratched)
  if (listing?.reason !== undefined && catalog === undefined) return Either.left({ asking: false, spoken: listing.reason })
  if (machine === undefined || catalog === undefined || project === undefined) {
    return Either.left({
      asking: true,
      spoken: `I can't start work outside your projects on ${listing?.machine ?? said}. Which project is ${decision.about.trim() || "that"} for?`,
    })
  }
  return Either.right(placed({ project, catalog, machine }, decision))
}

/** How a model may be named aloud: by its title, or the title's last word of letters, like "Sol" of "GPT 6.1 Sol" or "Opus" of "Claude Opus 5.5". */
const callings = (title: string) => {
  const last = title.split(/[\s-]+/).filter((word) => /^\p{L}{3,}$/u.test(word)).at(-1)
  return last === undefined ? [title] : [title, last]
}

/** Whether words say this, as a whole word or words, whatever its case. */
const says = (words: string, called: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${called.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(words)

/**
 * Whether the models the words name, if any, by any model's calling in the
 * catalog, could only be the one that started: "on Sol" can't be said of
 * work that started on Opus, nor "on GPT 6 Sol" of work on GPT 6.1 Sol.
 */
const namesOnly = (spoken: string, models: Catalog["models"], started: string) => {
  const own = models.filter(({ name }) => same(name, started)).flatMap(({ title }) => callings(title))
  return models.flatMap(({ title }) => callings(title)).every((called) => !says(spoken, called) || own.some((one) => same(one, called)))
}

/**
 * Whether the line for going ahead goes in front of what's said once new work
 * started: only before the writer's own words, when they match what started,
 * in its worktree and in the model they name, if any, since that's how he
 * catches a mishearing. An "On it" the writer put in front anyway goes, since
 * the line takes its place, and with only that there are no words of its own.
 */
export const ahead = (spoken: string, { request, catalog }: Pick<Resolved, "request" | "catalog">, started: Started, lines: Pick<Lines, "address">) =>
  started.worktree === request.worktree &&
  (request.model === undefined || same(request.model, started.model)) &&
  namesOnly(spoken, catalog.models, started.model) &&
  afterOnIt(spoken, lines) !== ""

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
  const title = catalog.models.find(({ name }) => same(name, started.model))?.title ?? started.model
  const where = started.worktree ? "in a worktree" : "without a worktree"
  const on = machine.here ? "" : ` on ${machine.name}`
  // Outside his projects, it's looked into rather than started somewhere, which is how he hears which it was, and there's no worktree to tell.
  const outside = scratched(project)
  const plain = outside ? `Looking into it${on}, on ${title}.` : `Started in ${project.name}${on}, on ${title}, ${where}.`
  // The writer's own words, or the plain facts: whether they say where it is goes by them alone, not by a line of his that may name a worktree.
  const own = ahead(spoken, { request, catalog }, started, lines)
  const told = own ? afterOnIt(spoken, lines) : plain
  return [
    own ? withOnIt(lines.onIt, told) : plain,
    // It's how they catch a worktree that was misheard, so it's never left to the writer alone.
    ...(outside || /work\s?-?tree/i.test(told) ? [] : [`That's ${where}.`]),
    ...(unsure ? [`I couldn't tell whether you wanted a worktree, so I went by your rules.`] : []),
    ...(started.warning === undefined ? [] : [started.warning]),
  ].join(" ")
}

/**
 * The confirmation it's likely to be, before it's known what started: as if
 * it starts as asked, in the worktree and on the model the request names,
 * with nothing the launcher had to add. None when it hangs on what only
 * starting tells, like the model when the request names none.
 */
export const expected = (spoken: string, resolved: Resolved, lines: Pick<Lines, "onIt" | "address">) =>
  resolved.request.model === undefined && !ahead(spoken, resolved, asAsked(resolved), lines) ? undefined : confirmation(spoken, resolved, asAsked(resolved), lines)

/** Work as it starts when it starts as asked, on the model the request names, if any. */
const asAsked = ({ request, project }: Pick<Resolved, "request" | "project">): Started => ({
  thread: "",
  project: called(project),
  directory: request.project,
  branch: null,
  model: request.model ?? "",
  worktree: request.worktree === true,
})

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
  /** It was asked for, and T3 Code is getting it ready, which takes minutes for a worktree: `then` is what comes of it, which can be waited for more than once. */
  | {
      readonly _tag: "Launching"
      readonly about: string
      readonly project: string
      readonly machine: Machine
      /** Asked for in a worktree, which T3 Code can take minutes to get ready. */
      readonly worktree: boolean
      readonly then: Effect.Effect<Outcome>
    }
  /** Nothing started, and this says why, or that there was nothing to start. */
  | { readonly _tag: "Said"; readonly spoken: string; readonly failed: boolean }

/** Notes work as it starts, in the same breath, so nothing can come between the two. */
export type Noted = (started: Extract<Outcome, { readonly _tag: "Started" }>) => Effect.Effect<void>

/** Which step of which request new work is, which its ids come from. */
export interface Step {
  readonly utterance: string
  readonly step: number
}

/** How long T3 Code has to show new work it didn't answer for, before it's looked for. */
const settling = "2 seconds"

/** Why new work T3 Code never answered for can't be told to have started: it was still getting it ready when a launch would have given up. */
export const readying = "T3 Code is still getting it ready, so I don't know if it started."

/** New work as T3 Code shows it, for one it started without saying so. A scratch thread's folder of its own isn't a worktree. */
const seen = (thread: T3Live.Thread, resolved: Pick<Resolved, "project">): Started => ({
  thread: thread.id,
  project: called(resolved.project),
  directory: thread.worktreePath ?? resolved.project.path,
  branch: thread.branch,
  model: thread.modelSelection.model,
  worktree: !scratched(resolved.project) && thread.worktreePath !== null,
})

/** What's said when the prompt couldn't be written. */
export const unwritten = "I couldn't write that up, so nothing started. What you said is in my log."

/** Starts new work on the machines there are, with the user's rules and what they heard lately to go by. */
export const make = (options: {
  readonly machines: ReadonlyArray<Machine>
  /** The user's rules, read as they are now. */
  readonly rules: Effect.Effect<Option.Option<string>>
  /** What they asked yapd to keep in mind by voice, as it is now. */
  readonly memories?: Effect.Effect<ReadonlyArray<Memory.Memory>>
  /** What the user was told lately, newest first. */
  readonly recent: Effect.Effect<ReadonlyArray<Heard>>
  /** Says which names there are, for what transcribes the dictation that's under way. */
  readonly expect?: (terms: ReadonlyArray<string>) => Effect.Effect<void>
  /** Where what's started is written down first, under the ids it's asked for with. */
  readonly ledger?: Ledger.Ledger["Type"]
  /** A thread as T3 Code has it now, to look once for new work that was asked for and never said whether it started. */
  readonly find?: (machine: string, thread: string) => Effect.Effect<Option.Option<T3Live.Thread>>
  /** Renders a line ahead on a guess, so it plays at once if it's what's said: the confirmation, while work starts. */
  readonly guess?: (line: string) => Effect.Effect<boolean>
}) =>
  Effect.gen(function* () {
    const writer = yield* Writer
    const persona = yield* Persona
    const scope = yield* Effect.scope
    const writing = yield* Effect.makeSemaphore(writers)

    const listing = (machine: Machine) =>
      machine.launcher.catalog.pipe(
        Effect.timeoutFail({ duration: patience, onTimeout: () => new LaunchError({ reason: `${machine.name} isn't answering.` }) }),
        Effect.match({
          onSuccess: (catalog): Listing => ({ machine: machine.name, here: machine.here, hosts: machine.hosts, catalog: Option.some(catalog) }),
          onFailure: ({ reason }): Listing => ({ machine: machine.name, here: machine.here, hosts: machine.hosts, catalog: Option.none(), reason }),
        }),
      )

    let fetched: { readonly at: number; readonly fiber: Fiber.RuntimeFiber<Array<Listing>> } | undefined
    /**
     * Asks every machine at once what it can start, telling what transcribes
     * the dictation which names there are, `terms` first, like the options
     * of a question it may answer, as they're likeliest and the list is cut
     * from the end.
     */
    const fetch = (titles: ReadonlyArray<string>, terms: ReadonlyArray<string> = []) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        const fiber = yield* Effect.forEach(options.machines, listing, { concurrency: "unbounded" }).pipe(
          Effect.tap((listings) => options.expect?.([...new Set([...terms, ...vocabulary(listings, titles)])]) ?? Effect.void),
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
     * on for good. As a step of a request, it's written down first under the
     * ids it's asked for with, so it's asked for once; and once it's written
     * down, nothing comes between that and asking for it, not even turning
     * yapd off, which would leave it as if it may have started when it never
     * was asked for.
     */
    const launch = (resolved: Resolved, spoken: string, why: string, about: string, noted: Noted, step?: Step) =>
      Effect.gen(function* () {
        const { machine, project } = resolved
        if (resolved.request.prompt === "") return { _tag: "Said", spoken: unwritten, failed: true } satisfies Outcome
        const ledger = options.ledger
        let request = resolved.request
        let commandId: string | undefined
        if (step !== undefined && ledger !== undefined) {
          const thread = crypto.randomUUID()
          const prepared = yield* ledger
            .prepare({
              ...step,
              kind: "start",
              machine: machine.name,
              thread,
              message: true,
              // Its words, by which its first turn is told to answer it, however long T3 Code takes to get it ready.
              digest: Ledger.digest(request.prompt),
              body: ({ commandId, messageId }) => ({ ...request, ids: { thread, message: messageId ?? "", command: commandId } }),
            })
            .pipe(Effect.either)
          if (Either.isLeft(prepared)) {
            yield* Effect.logWarning("Could not write down the work before starting it", prepared.left)
            return { _tag: "Said", spoken: "I couldn't write it down first, so I didn't start it.", failed: true } satisfies Outcome
          }
          // Asked for already, it's never asked for a second time.
          if (!prepared.right.fresh) {
            yield* Effect.logInfo(`${prepared.right.commandId} was asked for already, so it isn't again`)
            return { _tag: "Said", spoken: "I've already asked for that to start.", failed: false } satisfies Outcome
          }
          const { thread: id, messageId, commandId: command } = prepared.right
          request = { ...request, ids: { thread: id, message: messageId ?? "", command } }
          commandId = command
        }
        const settle = (state: "sent" | "failed" | "unknown", reason?: string) =>
          ledger === undefined || commandId === undefined ? Effect.void : ledger.settle(commandId, state, reason === undefined ? {} : { reason })
        yield* Effect.logInfo(
          `Decided: ${called(project)} on ${machine.name}, ${[request.model ?? "its usual model", request.effort].filter(Boolean).join(" ")}, ${
            request.worktree === true ? "in a worktree" : "without a worktree"
          }${request.baseBranch === undefined ? "" : ` from ${request.baseBranch}`}. ${why}`,
        )
        yield* Effect.logInfo(`Prompt: ${request.prompt}`)
        const launching = yield* Effect.gen(function* () {
          // What's likely to be said once it's started, rendered while it starts, with its line for going ahead picked now, so a guess
          // that's right is word for word what's said. One that's wrong is never played: what's said is rendered as ever.
          let picked: string | undefined
          if (options.guess !== undefined) {
            const lines = yield* persona.lines
            if (ahead(spoken, resolved, asAsked(resolved), lines)) picked = yield* persona.onIt()
            const line = expected(spoken, resolved, picked === undefined ? lines : { ...lines, onIt: picked })
            if (line !== undefined) yield* Effect.forkIn(options.guess(line), scope)
          }
          const asked = yield* Clock.currentTimeMillis
          const outcome = yield* Effect.either(machine.launcher.start(request))
          // Asked for and not answered, it may have started all the same: it's looked for under the id it was asked for with, and, found,
          // waited for while T3 Code is still getting it ready, as a launch that answers is, since a thread made for it doesn't say it started.
          // One T3 Code still hasn't put the work in by then is taken as not found, since it may yet put it in.
          const found =
            Either.isLeft(outcome) && outcome.left.sent === true && request.ids !== undefined && options.find !== undefined
              ? yield* Effect.zipRight(Effect.sleep(settling), readied(options.find(machine.name, request.ids.thread), asked))
              : Option.none<T3Live.Thread>()
          if (Either.isLeft(outcome) && !Option.exists(found, (thread) => progress(thread) === "begun")) {
            // Ended before it began, it didn't start; still being got ready by the time a launch would have given up, or not found, it can't be told yet.
            const ended = Option.flatMap(found, (thread) => unstarted(thread, request.worktree === true, scratched(project) ? undefined : project.name))
            const why = Option.getOrElse(ended, () => (Option.isSome(found) ? readying : outcome.left.reason))
            yield* Effect.logWarning(`Could not start: ${why}`, outcome.left)
            yield* settle(outcome.left.sent === true && Option.isNone(ended) ? "unknown" : "failed", why)
            return { _tag: "Said", spoken: about === "" ? why : `About ${about}: ${why}`, failed: true } satisfies Outcome
          }
          const started = Either.isRight(outcome) ? outcome.right : seen(Option.getOrThrow(found), resolved)
          if (Either.isLeft(outcome)) yield* Effect.logInfo(`Found ${started.thread} after all: ${outcome.left.reason}`)
          yield* settle("sent")
          yield* Effect.logInfo(`Started ${started.thread} in ${started.directory}`)
          // Picked only when it's said, or as it was guessed it would be, so a pick never played rarely keeps it from coming up, and noted
          // as heard by whoever says it, once it is.
          const written = yield* persona.lines
          const lines = ahead(spoken, resolved, started, written) ? { ...written, onIt: picked ?? (yield* persona.onIt()) } : written
          const begun = {
            _tag: "Started",
            spoken: confirmation(spoken, resolved, started, lines),
            started,
            machine,
            request,
            about,
          } satisfies Outcome
          yield* noted(begun)
          return begun
        }).pipe(Effect.interruptible, Effect.forkIn(scope))
        return { _tag: "Launching", about, project: called(project), machine, worktree: request.worktree === true, then: Fiber.join(launching) } satisfies Outcome
      }).pipe(Effect.uninterruptible)

    /** Carries out what the writer decided: starts it, or says what has to be asked, or why nothing started. */
    const start = (written: Written, noted: Noted = () => Effect.void, step?: Step): Effect.Effect<Outcome> =>
      Effect.gen(function* () {
        const { decision, material } = written
        const about = decision.about.trim()
        const asking = (question: string): Outcome => ({ _tag: "Asked", question, about, material })
        switch (decision.action) {
          case "ask":
            return asking(decision.spoken.trim() || `Which project is ${about || "that"} for?`)
          case "start": {
            // Outside his projects by the writer's word, it goes where only that can start, checked by the catalog's mark alone.
            if (decision.settled === "outside") {
              // Outside his projects and yet for one, the writer contradicted itself: that's no more settled than unclear. Its words for
              // it alone, like "in scratch", say nothing against it.
              if (decision.project.trim() !== "") {
                yield* Effect.logInfo(`Asking, since it was outside the projects and yet for "${decision.project}" by "${decision.evidence}". ${decision.why}`)
                return asking(`Which project is ${about || "that"} for?`)
              }
              const resolved = outside(options.machines, material.listings, decision)
              if (Either.isLeft(resolved) && !resolved.left.asking) {
                yield* Effect.logInfo(`Not starting outside the projects on ${decision.machine.trim() || "this machine"}: ${resolved.left.spoken} ${decision.why}`)
                return { _tag: "Said", spoken: about === "" ? resolved.left.spoken : `About ${about}: ${resolved.left.spoken}`, failed: true } satisfies Outcome
              }
              if (Either.isLeft(resolved)) {
                yield* Effect.logInfo(`Asking, since there's nowhere to start work outside the projects on ${decision.machine.trim() || "this machine"}. ${decision.why}`)
                return asking(resolved.left.spoken)
              }
              return yield* launch(resolved.right, decision.spoken, decision.why, about, noted, step)
            }
            // A project the writer couldn't say why it chose is a guess.
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
            return yield* launch(resolved.right, decision.spoken, decision.why, about, noted, step)
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
      /** The user started dictating: what's ready by the time they've finished doesn't hold the prompt up. `terms` are what it's likeliest to hold. */
      prepare: (titles: ReadonlyArray<string>, terms?: ReadonlyArray<string>) => Effect.zipRight(fetch(titles, terms), writer.prepare).pipe(Effect.asVoid),
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
                  memories: yield* options.memories ?? Effect.succeed([]),
                  recent: yield* options.recent,
                  earlier: [],
                  lines,
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
    }
  })

/** What starts new work. */
export type Drafts = Effect.Effect.Success<ReturnType<typeof make>>
