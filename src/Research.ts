import { Data, type Duration, Effect, Schema } from "effect"

// A prompt that can't be written without reading the project is researched
// where the project is, like new work is started there: a project on another
// machine only exists on it. So `yapd research` runs there over SSH, with that
// machine's own provider, and answers with what the model wrote.

/** What to find out, and the checkout to look through. */
export const Request = Schema.Struct({
  /** The project's checkout, on the machine that's asked. */
  directory: Schema.String,
  prompt: Schema.String,
  /** JSON Schema of the reply. */
  schema: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
})
export type Request = typeof Request.Type

/** Nothing was found out. The reason is for the log, and what's written goes without. */
export class ResearchError extends Data.TaggedError("ResearchError")<{ readonly reason: string; readonly cause?: unknown }> {}

/** Reads through projects on one machine, and can't change them. */
export interface Researcher {
  /** False when it's known ahead that it can't, so nothing is left for it to look up. */
  readonly available: boolean
  /** The model's reply, still to be checked against the schema. */
  readonly research: (request: Request) => Effect.Effect<unknown, ResearchError>
}

/** Long enough to read through a large repository, which takes a minute or two. */
export const patience: Duration.DurationInput = "5 minutes"

/** Stands in where nothing can research, like with a provider that can't be kept from writing. */
export const unavailable = (reason: string): Researcher => ({
  available: false,
  research: () => Effect.fail(new ResearchError({ reason })),
})

/** Either the reply, or the reason there's none. */
export const Response = Schema.Struct({ reply: Schema.optional(Schema.Unknown), reason: Schema.optional(Schema.String) })

/** `yapd research`: reads through the project named on stdin and prints what the model wrote. */
export const serve = (researcher: Researcher, input: string) =>
  Schema.decodeUnknown(Schema.parseJson(Request))(input).pipe(
    Effect.mapError(() => new ResearchError({ reason: "yapd here and on the machine that speaks don't match. Update both." })),
    Effect.flatMap(researcher.research),
    Effect.map((reply) => Response.make({ reply })),
    Effect.catchTag("ResearchError", ({ reason }) => Effect.succeed(Response.make({ reason }))),
    Effect.map((response) => JSON.stringify(response)),
  )

/**
 * Researches on another machine. `ask` runs `yapd research` there with the
 * request on its stdin, and returns the line it answered with.
 */
export const remote = (host: string, ask: (stdin: string) => Effect.Effect<string, ResearchError>): Researcher => ({
  available: true,
  research: (request) =>
    Effect.gen(function* () {
      const answer = yield* ask(JSON.stringify(Request.make(request)))
      const { reply, reason } = yield* Schema.decodeUnknown(Schema.parseJson(Response))(answer).pipe(
        Effect.mapError((cause) => new ResearchError({ reason: `yapd on ${host} answered in a way I don't understand.`, cause })),
      )
      return reply ?? (yield* new ResearchError({ reason: reason ?? `yapd on ${host} answered in a way I don't understand.` }))
    }),
})
