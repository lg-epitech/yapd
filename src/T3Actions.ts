import { Effect, Option, Schema } from "effect"
import * as Server from "./T3CodeServer.ts"

// What yapd can do to T3 Code's threads for the user: read where one got to,
// tell it something, stop it, answer what it's waiting on, and tidy it away.
// Each is a command T3 Code's own app sends, so its view stays in step.

const Message = Schema.Struct({
  id: Schema.optional(Schema.String),
  /** The run it was said in. */
  runId: Schema.optional(Schema.NullOr(Schema.String)),
  role: Schema.String,
  text: Schema.String,
  createdAt: Schema.String,
  streaming: Schema.optionalWith(Schema.Boolean, { default: () => false }),
})

const Run = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  ordinal: Schema.Number,
  /** The message that started it, or waits in the queue to. */
  userMessageId: Schema.optional(Schema.NullOr(Schema.String)),
  requestedAt: Schema.optional(Schema.NullOr(Schema.String)),
  startedAt: Schema.optional(Schema.NullOr(Schema.String)),
  /** When it ended, or, for one that went well, when what it changed was taken stock of, a moment after. */
  completedAt: Schema.optional(Schema.NullOr(Schema.String)),
})

const Option_ = Schema.Struct({ decision: Schema.String, label: Schema.String })

const Question = Schema.Struct({
  id: Schema.String,
  header: Schema.optionalWith(Schema.String, { default: () => "" }),
  question: Schema.String,
  options: Schema.optionalWith(
    Schema.Array(
      Schema.Struct({
        label: Schema.String,
        description: Schema.optionalWith(Schema.String, { default: () => "" }),
        /** What the answer carries when it isn't the label, as some forms have. */
        value: Schema.optional(Schema.String),
      }),
    ),
    { default: () => [] },
  ),
  multiSelect: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  allowCustomAnswer: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  /** Whether it needs an answer, which one answered as a message does for every part it needs. */
  required: Schema.optionalWith(Schema.Boolean, { default: () => true }),
})

/** Why a run failed, as T3 Code classes it, like "usage_limit", and when the limit it hit resets, when it says. */
const Failure = Schema.Struct({
  class: Schema.String,
  message: Schema.String,
  resetAt: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
})

/** What a thread waits on, and what it ran into, as its turn items describe it. Anything else in them is left alone. */
const Item = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  runId: Schema.optional(Schema.NullOr(Schema.String)),
  /** The agent's own id for what it did, which an approval shares with the command or change it's for. */
  nativeItemRef: Schema.optional(Schema.NullOr(Schema.Struct({ nativeId: Schema.optional(Schema.NullOr(Schema.String)) }))),
  /** A user message's own id, and how it went in. */
  messageId: Schema.optional(Schema.String),
  inputIntent: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.String),
  requestKind: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  options: Schema.optional(Schema.Array(Option_)),
  questions: Schema.optional(Schema.Array(Question)),
  /** "message" for a question answered as a message to the thread, like one Codex asked in its reply, which outlives its run. */
  responseMode: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
  toolName: Schema.optional(Schema.NullOr(Schema.String)),
  fileName: Schema.optional(Schema.String),
  /** What a secret it asks for is called. */
  label: Schema.optional(Schema.String),
  failure: Schema.optional(Failure),
})

const Plan = Schema.Struct({
  kind: Schema.String,
  status: Schema.String,
  markdown: Schema.optional(Schema.String),
  steps: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.String, status: Schema.String }))),
})

/** One of the agent conversations behind a thread, by the agent's own id for it: a bare id, or the one in a reference. */
const ProviderThread = Schema.Struct({
  nativeThreadRef: Schema.optionalWith(
    Schema.NullOr(Schema.Union(Schema.String, Schema.Struct({ nativeId: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }) }))),
    { default: () => null },
  ),
})

/** A request T3 Code keeps for a thread, and whether it still waits on it: "pending" until it's answered, expires or is cancelled. */
const RuntimeRequest = Schema.Struct({ id: Schema.String, status: Schema.String })

const Bounded = Schema.Struct({
  projection: Schema.Struct({
    runs: Schema.Array(Run),
    messages: Schema.Array(Message),
    turnItems: Schema.Array(Schema.Unknown),
    plans: Schema.optionalWith(Schema.Array(Schema.Unknown), { default: () => [] }),
    providerThreads: Schema.optionalWith(Schema.Array(Schema.Unknown), { default: () => [] }),
    runtimeRequests: Schema.optionalWith(Schema.Array(Schema.Unknown), { default: () => [] }),
  }),
})

/** What a thread waits on the user for, in words that can be read out and answered. */
export type Request =
  | {
      readonly _tag: "Approval"
      readonly id: string
      /** What it wants to do, like the command it would run. */
      readonly what: string
      readonly kind: string
      /** The decisions it takes, like accept or decline. Every decision when the agent didn't say. */
      readonly decisions: ReadonlyArray<{ readonly decision: string; readonly label: string }>
      /** The command it would run, the file it would change or the tool it would call, when the thread shows it, cut short to be said. */
      readonly command?: string
      /**
       * All of what it would run, change or call, as it would run, when the
       * thread shows all of it and it isn't too long to look through, which
       * is what tells whether it's risky: what's said of it, or T3 Code's own
       * words for it, may be cut short before the risky part.
       */
      readonly whole?: string
    }
  | {
      readonly _tag: "Question"
      readonly id: string
      readonly questions: ReadonlyArray<typeof Question.Type>
      /** How T3 Code takes the answer: "live", straight to the agent waiting on it, or "message", as a message to the thread, with every part it needs answered. */
      readonly mode: "live" | "message"
    }
  /** A secret it asks for, like a key, which is only ever given in T3 Code. */
  | { readonly _tag: "Secret"; readonly id: string; readonly label: string }

/**
 * Whether what a thread says it waits on is a secret, which T3 Code stands in
 * for a question in its summary of the thread, under the id of the card that
 * asks for it. It's only ever given in T3 Code.
 */
export const secret = (id: string) => id.startsWith("turn-item:secret-request:")

/** What answering with an option sends: its value when it has one, which isn't always its label. */
export const choice = (option: { readonly label: string; readonly value?: string | undefined }) => option.value ?? option.label

/** Where a thread got to: its latest messages, and what it waits on, if anything. */
export interface Detail {
  /** Oldest first, the last few. */
  readonly messages: ReadonlyArray<typeof Message.Type>
  readonly runs: ReadonlyArray<typeof Run.Type>
  readonly request: Option.Option<Request>
  /** Its plan or to-do list, if it has one under way. */
  readonly plan: Option.Option<string>
  /** Every request it still waits on him for, oldest first, even one asked alongside a newer one, which its summary in T3 Code hides. */
  readonly pending: ReadonlyArray<string>
}

const decodeItem = Schema.decodeUnknownOption(Item)
const decodePlan = Schema.decodeUnknownOption(Plan)
const decodeRuntimeRequest = Schema.decodeUnknownOption(RuntimeRequest)

const every = [
  { decision: "accept", label: "Allow" },
  { decision: "acceptForSession", label: "Allow for this session" },
  { decision: "decline", label: "Deny" },
]

/** The turn items a thread waits on the user for. */
const asking: ReadonlyArray<string> = ["approval_request", "user_input_request", "secret_request"]

/**
 * The requests a thread still waits on him for, oldest first: by T3 Code's
 * own record of each, which keeps one asked alongside a newer one that the
 * thread's summary shows instead, or by its turn items when it keeps none.
 */
export const waitingOn = (projection: Pick<(typeof Bounded.Type)["projection"], "runtimeRequests" | "turnItems">): ReadonlyArray<string> => {
  const kept = projection.runtimeRequests.flatMap((request) => Option.toArray(decodeRuntimeRequest(request)))
  if (kept.length > 0) return kept.filter(({ status }) => status === "pending").map(({ id }) => id)
  return projection.turnItems
    .flatMap((item) => Option.toArray(decodeItem(item)))
    .filter(({ type, status }) => asking.includes(type) && (status === "waiting" || status === "pending"))
    .flatMap(({ type, id, requestId }) => Option.toArray(Option.fromNullable(type === "secret_request" ? id : requestId)))
}

/** How much of a command or a tool's input is kept to be said: enough to tell what it does. */
const commandLength = 600
/** How much of one is looked through for what's risky, at most: longer, like a tool given a whole file, it's taken for unread. */
const checkable = 20_000

/**
 * Whether T3 Code sent only how a tool's input starts, in its place, as it
 * does with one too big to send whole: what comes after could be anything.
 */
const cutShort = (input: unknown) => typeof input === "object" && input !== null && (input as { readonly truncated?: unknown }).truncated === true

/** Text that's JSON itself, as what it holds. */
const json = Schema.decodeUnknownOption(Schema.parseJson())

/**
 * What a tool is given, as it gets it: each name and each value on a line of
 * its own, and its text as it is, where its JSON writes a line break as "\n"
 * run into the next word, which hides a command on a line of its own. Text
 * that's JSON itself, like an input sent as one string, is read as what it
 * holds, the same way, and a list of words, like a command and what it's
 * given, is one line, as it runs, so a flag isn't cut off from its command;
 * so is a command given apart from its words, after the rest, whose words
 * are then never a line of their own, as if they ran alone.
 */
const given = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return Option.match(/^\s*[[{]/.test(value) ? json(value) : Option.none(), { onNone: () => [value], onSome: given })
  if (Array.isArray(value)) return value.every((item) => typeof item === "string") ? [value.join(" ")] : value.flatMap(given)
  if (typeof value === "object" && value !== null) {
    const run = commandLine(value)
    return [...Object.entries(value).flatMap(([name, inner]) => [name, ...(name === run.words ? [] : given(inner))]), ...run.lines]
  }
  return value === undefined || value === null ? [] : [String(value)]
}

/** What a tool may call what it runs, given apart from its words, like `program` or `executable`. */
const whatRuns = ["command", "cmd", "program", "executable", "exe", "binary", "bin", "file"]

/**
 * A command given apart from its words, like `{"command": "rm", "args":
 * ["-rf", "x"]}` or `{"program": "rm", …}`, as the one line it runs as,
 * under each name that could be what runs, and the name its words are
 * under, which never run alone: `{"command": "git", "args": ["log",
 * "--grep", "clean", "-f"]}` runs a log, never a `clean -f`.
 */
const commandLine = (value: object): { readonly words?: string; readonly lines: ReadonlyArray<string> } => {
  const fields = value as Readonly<Record<string, unknown>>
  const words = ["args", "argv", "arguments"].find((name) => fields[name] !== undefined && fields[name] !== null)
  const listed = words === undefined ? undefined : fields[words]
  const line = typeof listed === "string" ? listed : Array.isArray(listed) && listed.every((word) => typeof word === "string") ? listed.join(" ") : undefined
  if (words === undefined || line === undefined) return { lines: [] }
  const lines = whatRuns.flatMap((name) => {
    const named = fields[name]
    return typeof named === "string" ? [`${named} ${line}`] : []
  })
  return lines.length === 0 ? { lines } : { words, lines }
}

/**
 * What an approval is for, from the item it shares the agent's id with: the
 * command, the file it changes, or the tool and what it's given, as it's
 * said, and all of it as it would run, to look through for what's risky,
 * when T3 Code sent all of it.
 */
const wouldRun = (items: ReadonlyArray<typeof Item.Type>, approval: typeof Item.Type) => {
  const native = approval.nativeItemRef?.nativeId
  if (native === null || native === undefined) return undefined
  const found = items.find((item) => item.type !== "approval_request" && item.nativeItemRef?.nativeId === native)
  const text = ((): { readonly said: string; readonly whole: string | undefined } | undefined => {
    switch (found?.type) {
      case "command_execution":
        return typeof found.input === "string" ? { said: found.input, whole: found.input } : undefined
      case "file_change":
        return found.fileName === undefined ? undefined : { said: `change ${found.fileName}`, whole: `change ${found.fileName}` }
      case "dynamic_tool": {
        const tool = found.toolName ?? "a tool"
        return {
          said: `${tool} ${JSON.stringify(found.input ?? null)}`,
          whole: cutShort(found.input) ? undefined : [tool, ...given(found.input)].join("\n"),
        }
      }
      default:
        return undefined
    }
  })()
  if (text === undefined || text.said.trim() === "") return undefined
  return { said: text.said.trim(), whole: text.whole?.trim() }
}

/**
 * What names something only he should type in, like a password, a key or a
 * token to sign in with, as words of its own, where "_" parts words as a
 * space does, as in "api_key".
 */
const credentials = new RegExp(
  String.raw`(?<![a-z0-9])(?:${[
    String.raw`pass(?:word|phrase|code)s?|passwd`,
    String.raw`(?:api|access|secret|private|ssh|signing|deploy|license|encryption|master)[ _-]?keys?`,
    String.raw`(?:api|access|auth|bearer|refresh|personal access|github|gitlab|npm|pypi|session|id)[ _-]?tokens?`,
    String.raw`(?:one[ -]time|verification|auth(?:entication|orization)?|2fa|mfa|sms|security|recovery|backup|login|sign[ -]?in) (?:codes?|passwords?)`,
    // A code he's sent, like "the code sent to your phone", or "the code we texted you".
    String.raw`codes?(?= (?:\w+ )?(?:sent|texted|emailed|messaged)\b)`,
    // What gives a wallet away: its phrase, or its words.
    String.raw`(?:recovery|seed|wallet|backup) (?:phrases?|words)|(?:12|24|twelve|twenty[ -]four) words`,
    String.raw`webhooks? urls?|auth(?:orization)? headers?`,
    String.raw`connection (?:strings?|ur[il]s?)|(?:database|db)[ _-]?ur[il]`,
    String.raw`secrets?|credentials?|mnemonic|otp|jwt|dsn|\.env|bearer|logins?|service[ _-]?accounts?`,
  ].join("|")})(?![a-z0-9])`,
  "i",
)

/** One named as it's written in code, in capitals, like OPENAI_API_KEY, HF_TOKEN or SENTRY_AUTH, or that's only ever one in capitals, like a PAT or a PIN. */
const capitals = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|PAT|DSN|AUTH|CREDENTIALS?|URL|URI)S?\b|\b(?:PAT|PIN)s?\b/

/** What names one only when he's asked to give it, or isn't asked to pick, since a token or a key is often something else, like a coin or a field. */
const bare = /(?<![a-z0-9])(?:keys?|tokens?|pwd|cookies?|webhooks?|pin (?:code|number)s?)(?![a-z0-9])/i

/** Asking him to give something, rather than to pick or say which. */
const giving = /\b(?:your|paste|enter|provide|give|share|send|type|supply|need|set|copy)\b|\bwhat(?:'s|’s| is) the\b/i

/** Asking him to pick, or say which, which a token or a key may well be, like a coin to track or a field to sort by. */
const picking = /\b(?:which|choose|pick|select|prefer|rather|should|or)\b/i

/** The credential a question names, if it names one. */
const named = (text: string) =>
  capitals.exec(text)?.[0] ?? credentials.exec(text)?.[0] ?? (giving.test(text) || !picking.test(text) ? bare.exec(text)?.[0] : undefined)

/** A number word, as a digit said on its own is heard. */
const digits: ReadonlySet<string> = new Set(["zero", "oh", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"])

/** What gives a secret away as it's written: a key's own prefix, like sk-, ghp_, xoxb- or AKIA, or "the key is …". */
const giveaway = new RegExp(
  [
    String.raw`\b(?:sk|pk|rk)(?:[ _-]+(?:live|test|proj|ant))?[_-][a-z0-9]`,
    String.raw`\b(?:sk|pk|rk)[ _-]+(?:live|test|proj|ant)\b`,
    String.raw`\b(?:ghp|gho|ghs|ghu|github_pat|glpat|xox[abposr]|npm)_[a-z0-9]|\bxox[abposr]-|\bAKIA[0-9A-Z]{8,}`,
    String.raw`\b(?:key|token|code|password|passphrase|pin|secret|phrase)\s+(?:is|=)\s+\S`,
  ].join("|"),
  "i",
)

/**
 * Whether what he'd send gives a secret away, however the question it
 * answers was worded: four digits or more said one by one, or a code written
 * as one, like a one-time code or a PIN; a key's own prefix; letters and
 * digits run together as a token is; or "the key is …". Taken for one
 * whenever it could be, since it then goes only by T3 Code.
 */
export const revealing = (text: string) => {
  if (giveaway.test(text)) return true
  let run = 0
  for (const word of text.toLowerCase().split(/[\s,;:]+|(?<=\d)-(?=\d)/)) {
    const bare = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    // A code written as one, six digits or more, as a port, a year or a PR number isn't.
    if (/^\d{6,}$/.test(bare)) return true
    // Letters and digits run together, like a token or a key, longer than any word or name.
    if (/^[\p{L}\p{N}_-]{16,}$/u.test(bare) && /\d/.test(bare) && /\p{L}/u.test(bare)) return true
    run = /^\d$/.test(bare) || digits.has(bare) ? run + 1 : 0
    if (run >= 4) return true
  }
  return false
}

/**
 * What a question asks him to type in that's a secret, if one does: one with
 * nothing to pick from that names a credential, like a Codex question marked
 * secret, which T3 Code passes on as any other. Taken for one whenever it
 * could be, since it's then only told, by what the question names, or
 * else its header, like "GitHub token". None for a question with options,
 * whose answer is one of them.
 */
const credential = (questions: ReadonlyArray<typeof Question.Type>) =>
  questions
    .flatMap(({ header, question, options }) => (options.length > 0 ? [] : Option.toArray(Option.fromNullable(named(question) ?? named(`${header} ${question}`)))))
    .at(0)

/**
 * Reads what a thread waits on out of its turn items, by the request's id. A
 * secret it asks for goes by its item's own id, which is the one the thread
 * says it waits on; a question that asks him to type in a secret is one too,
 * under the question's id.
 */
export const request = (items: ReadonlyArray<unknown>, id: string): Option.Option<Request> => {
  const decoded = items.flatMap((item) => Option.toArray(decodeItem(item)))
  for (const found of decoded.toReversed()) {
    if (found.type === "secret_request" && found.id === id) return Option.some({ _tag: "Secret", id, label: found.label ?? "" })
    if (found.requestId !== id) continue
    if (found.type === "user_input_request" && found.questions !== undefined) {
      const named = credential(found.questions)
      const mode = found.responseMode === "message" ? "message" : "live"
      return Option.some(named === undefined ? { _tag: "Question", id, questions: found.questions, mode } : { _tag: "Secret", id, label: named })
    }
    if (found.type === "approval_request") {
      const runs = wouldRun(decoded, found)
      const command = runs?.said.slice(0, commandLength)
      return Option.some({
        _tag: "Approval",
        id,
        what: found.prompt ?? found.title ?? command ?? "something it needs your permission for",
        kind: found.requestKind ?? "permission",
        decisions: found.options !== undefined && found.options.length > 0 ? found.options : every,
        ...(command === undefined ? {} : { command }),
        ...(runs?.whole === undefined || runs.whole.length > checkable ? {} : { whole: runs.whole }),
      })
    }
  }
  return Option.none()
}

const decodeProviderThread = Schema.decodeUnknownOption(ProviderThread)

/** The agent's own ids for the conversations behind a thread, which its hooks report as their session. */
export const natives = (providerThreads: ReadonlyArray<unknown>): ReadonlyArray<string> =>
  providerThreads.flatMap((thread) =>
    Option.match(decodeProviderThread(thread), {
      onNone: () => [],
      onSome: ({ nativeThreadRef: ref }) => {
        const id = typeof ref === "string" ? ref : ref?.nativeId
        return id === null || id === undefined || id.trim() === "" ? [] : [id]
      },
    }),
  )

/** How a run of a thread went, as far as yapd tells of it. */
export interface Ran {
  readonly id: string
  /** Like "completed", "waiting" (its turn is over, its checkpoint isn't taken yet), "failed" or "interrupted". */
  readonly status: string
  /** When it got going, in ms, or was asked for when it never did. */
  readonly startedAt: Option.Option<number>
  /** The message that started it: yapd's own have ids starting "yapd:". */
  readonly userMessageId: Option.Option<string>
  /** What it was asked, when that message is still among those read back. */
  readonly prompt: Option.Option<string>
  /** What it said back, oldest first, as one. */
  readonly said: string
  /** What it said last, which is what its Stop hook says last too: how a Stop is told to be its own. */
  readonly final: string
  /** What each of the thread's other runs read with it said last, so a Stop of theirs, like the run before's come late, isn't taken for its own. */
  readonly others: ReadonlyArray<string>
  /** Why it failed, when it did. */
  readonly failure: Option.Option<typeof Failure.Type>
  /** The agent's own ids for the thread's conversations. */
  readonly natives: ReadonlyArray<string>
  /** The last run before it that didn't fail or stop before it said anything, when that went well, so a Stop hook came of it: when it started and ended, in ms, for when words can't tell whose a Stop is. */
  readonly previous: Option.Option<{ readonly startedAt: number; readonly endedAt: number }>
}

const instant = (iso: string | null | undefined) =>
  Option.filter(Option.map(Option.fromNullable(iso), Date.parse), (at) => !Number.isNaN(at))

/** What a run said back, oldest first: only what's done being said, and not empty. */
const answers = (projection: (typeof Bounded.Type)["projection"], runId: string) =>
  projection.messages
    .filter(({ role, runId: said, streaming }) => role === "assistant" && said === runId && !streaming)
    .map(({ text }) => text.trim())
    .filter((text) => text !== "")

/** How one of the thread's runs went, by its id, out of a bounded read. */
export const ran = (projection: (typeof Bounded.Type)["projection"], runId: string): Option.Option<Ran> => {
  const run = projection.runs.find(({ id }) => id === runId)
  if (run === undefined) return Option.none()
  const said = answers(projection, runId)
  const failure = projection.turnItems
    .flatMap((item) => Option.toArray(decodeItem(item)))
    .filter((item) => item.type === "error" && item.runId === runId && item.status === "failed")
    .at(-1)?.failure
  const prompt = projection.messages.find(({ id, role }) => role === "user" && id !== undefined && id === run.userMessageId)?.text
  const startedAt = Option.orElse(instant(run.startedAt), () => instant(run.requestedAt))
  // The last that got going before it, but for any that failed, which have no Stop hook, nor one stopped before it said anything, which
  // has none either, like a message sent and stopped at once: one taken out of the queue never got going.
  const before = projection.runs
    .filter(
      ({ id, ordinal, startedAt, status }) =>
        ordinal < run.ordinal &&
        status !== "failed" &&
        !(["interrupted", "cancelled"].includes(status) && answers(projection, id).length === 0) &&
        Option.isSome(instant(startedAt)),
    )
    .toSorted((a, b) => b.ordinal - a.ordinal)[0]
  return Option.some({
    id: run.id,
    status: run.status,
    startedAt,
    userMessageId: Option.fromNullable(run.userMessageId),
    prompt: Option.filter(Option.fromNullable(prompt), (text) => text.trim() !== ""),
    said: said.join("\n\n"),
    final: said.at(-1) ?? "",
    others: projection.runs.flatMap(({ id }) => (id === runId ? [] : Option.toArray(Option.fromNullable(answers(projection, id).at(-1))))),
    failure: Option.fromNullable(failure),
    natives: natives(projection.providerThreads),
    // One that went well ended by the time this one started, which is when it's taken to have when T3 Code doesn't say.
    previous:
      before !== undefined && ["completed", "waiting"].includes(before.status)
        ? Option.all({ startedAt: instant(before.startedAt), endedAt: Option.orElse(instant(before.completedAt), () => startedAt) })
        : Option.none(),
  })
}

/** A plan under way, as a few lines. */
export const plan = (plans: ReadonlyArray<unknown>): Option.Option<string> => {
  const active = plans.flatMap((plan) => Option.toArray(decodePlan(plan))).filter(({ status }) => status === "active")
  const latest = active.at(-1)
  if (latest === undefined) return Option.none()
  if (latest.steps !== undefined) return Option.some(latest.steps.map(({ text, status }) => `- [${status}] ${text}`).join("\n"))
  return Option.fromNullable(latest.markdown)
}

/** How many of a thread's messages are read back. */
const recent = 6

/**
 * When a message goes in: `now`, into the turn under way when there is one,
 * as the app sends it; `after` the turn under way, in T3 Code's own queue;
 * or `restart`, in place of the turn under way, which yapd stops first, as a
 * step of its own, so it then goes as `now` does.
 */
export type When = "now" | "after" | "restart"

export type Command =
  | {
      readonly _tag: "Send"
      readonly text: string
      /** Chosen by yapd, so the message can be found in the thread. */
      readonly messageId: string
      readonly how: When
    }
  | { readonly _tag: "Stop" }
  /** Lets go of the queue a stop held. */
  | { readonly _tag: "Resume" }
  /** Drops a message still waiting in the queue, by the run it would start. Its own id isn't sent, but is how it's looked for after. */
  | { readonly _tag: "Cancel"; readonly runId: string; readonly messageId?: string }
  | { readonly _tag: "Decide"; readonly requestId: string; readonly decision: string }
  | { readonly _tag: "Answer"; readonly requestId: string; readonly answers: Readonly<Record<string, string | ReadonlyArray<string>>> }
  | { readonly _tag: "Dismiss"; readonly requestId: string }
  | { readonly _tag: "Archive" }
  | { readonly _tag: "Unarchive" }
  | { readonly _tag: "Rename"; readonly title: string }
  | { readonly _tag: "Snooze"; readonly until: string }
  | { readonly _tag: "Settle" }
  | { readonly _tag: "Pin" }

/** The command T3 Code takes for it, under an id of its own, so sending it twice does it once. */
export const command = (threadId: string, what: Command, runId: string | undefined, commandId: string) => {
  const base = { commandId, threadId }
  switch (what._tag) {
    case "Send":
      return {
        ...base,
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        messageId: what.messageId,
        text: what.text,
        attachments: [],
        // As the app does: into the turn under way when the agent can take it, and after it when it can't; or in the queue, with no intent.
        // Never T3 Code's own restart, which it turns down for a turn getting going, waiting, or busy only in the background.
        ...(what.how === "after" ? { dispatchMode: { type: "queue_after_active" } } : { dispatchMode: { type: "start_immediately" }, deliveryIntent: "auto" }),
      }
    case "Stop":
      return { ...base, type: "run.interrupt", runId, holdQueue: true }
    case "Resume":
      return { ...base, type: "queue.resume" }
    case "Cancel":
      return { ...base, type: "queued-run.cancel", runId: what.runId }
    case "Decide":
      return { ...base, type: "runtime-request.respond", requestId: what.requestId, decision: what.decision }
    case "Answer":
      return { ...base, type: "runtime-request.respond", requestId: what.requestId, answers: what.answers }
    case "Dismiss":
      return { ...base, type: "thread.user-input.dismiss", requestId: what.requestId }
    case "Archive":
      return { ...base, type: "thread.archive" }
    case "Unarchive":
      return { ...base, type: "thread.unarchive" }
    case "Rename":
      return { ...base, type: "thread.metadata.update", title: what.title }
    case "Snooze":
      return { ...base, type: "thread.snooze", snoozedUntil: what.until }
    case "Settle":
      return { ...base, type: "thread.settle" }
    case "Pin":
      return { ...base, type: "thread.pin" }
  }
}

/** Runs that are still going, and can be stopped. */
const going: ReadonlyArray<string> = ["preparing", "starting", "running", "waiting"]

/** How a message went into a thread, as T3 Code says: starting a turn, into the turn under way, or in the queue behind it. */
export type Intent = "turn_start" | "queued_turn" | "steer" | "promoted_queued_to_steer"

const intents: ReadonlyArray<string> = ["turn_start", "queued_turn", "steer", "promoted_queued_to_steer"]

/** Where a message yapd sent got to in a thread. */
export interface Found {
  /** How it went in, when the thread says. */
  readonly intent: Option.Option<Intent>
  /** The run it started, or waits in the queue to start, if there's one. */
  readonly run: Option.Option<{ readonly id: string; readonly status: string }>
  /** When T3 Code took it in, in ms by its own clock, when the thread shows the message itself. */
  readonly at: Option.Option<number>
}

/** Finds a message yapd sent in a thread's bounded read: among its messages, the runs they started, or its turn items. */
export const found = (projection: (typeof Bounded.Type)["projection"], messageId: string): Option.Option<Found> => {
  const run = projection.runs.find(({ userMessageId }) => userMessageId === messageId)
  const item = projection.turnItems
    .flatMap((item) => Option.toArray(decodeItem(item)))
    .find((item) => item.type === "user_message" && item.messageId === messageId)
  const message = projection.messages.find(({ id }) => id === messageId)
  if (run === undefined && item === undefined && message === undefined) return Option.none()
  const intent = item?.inputIntent
  return Option.some({
    // One with no turn item yet still has its run to say: one it started is a turn of its own, unless it waits in the queue or was taken out of it.
    intent:
      intent !== undefined && intents.includes(intent)
        ? Option.some(intent as Intent)
        : run === undefined || run.status === "cancelled"
          ? Option.none()
          : Option.some(run.status === "queued" ? ("queued_turn" as const) : ("turn_start" as const)),
    run: Option.map(Option.fromNullable(run), ({ id, status }) => ({ id, status })),
    at: Option.filter(Option.map(Option.fromNullable(message), ({ createdAt }) => Date.parse(createdAt)), (at) => !Number.isNaN(at)),
  })
}

const Dispatched = Schema.Struct({ sequence: Schema.Number })

const Search = Schema.Struct({
  matches: Schema.Array(
    Schema.Struct({
      threadId: Schema.String,
      projectId: Schema.String,
      source: Schema.String,
      snippet: Schema.String,
      messageCreatedAt: Schema.NullOr(Schema.String),
    }),
  ),
})

const Limits = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({
      instanceId: Schema.String,
      displayName: Schema.optional(Schema.String),
      enabled: Schema.Boolean,
      status: Schema.String,
      usageLimits: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            windows: Schema.optionalWith(
              Schema.Array(
                Schema.Struct({
                  kind: Schema.String,
                  label: Schema.String,
                  usedPercent: Schema.Number,
                  resetsAt: Schema.optional(Schema.NullOr(Schema.String)),
                  windowDurationMins: Schema.optional(Schema.NullOr(Schema.Number)),
                }),
              ),
              { default: () => [] },
            ),
          }),
        ),
      ),
    }),
  ),
})

/** One of a provider's limits: "session", "weekly", "monthly" or "other", as T3 Code labels it, and how long it lasts when it says. */
export interface Window {
  readonly kind: string
  readonly label: string
  readonly minutes: number | undefined
  readonly usedPercent: number
  readonly resetsAt: string | undefined
}

/** What T3 Code says each provider has used of its limits. */
export type Usage = ReadonlyArray<{ readonly provider: string; readonly windows: ReadonlyArray<Window> }>

/** Why T3 Code wouldn't, in words that can be read out. */
export const reason = (error: Server.Trouble | Server.Refusal) =>
  error._tag === "Trouble"
    ? error.reason
    : error.tag === "EnvironmentAuthorizationError"
      ? "My T3 Code token isn't allowed to do that."
      : error.message

export const make = (reach: Effect.Effect<Server.Transport, Server.Trouble>) => {
  /** The thread's last turns, as T3 Code bounds them. */
  const bounded = (threadId: string) =>
    Effect.flatMap(reach, ({ api }) => api(`/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`, Bounded))

  /** Where a message yapd sent got to in the thread, if it's there at all. */
  const message = (threadId: string, messageId: string) => Effect.map(bounded(threadId), ({ projection }) => found(projection, messageId))

  return {
    /** Where it got to. `pending` is the request the shell says it waits on, when it knows. */
    detail: (threadId: string, pending?: string) =>
      Effect.gen(function* () {
        const { projection } = yield* bounded(threadId)
        // Otherwise the newest that's still waiting, a secret by its own id.
        const waiting =
          pending ??
          projection.turnItems
            .flatMap((item) => Option.toArray(decodeItem(item)))
            .filter(({ type, status }) => asking.includes(type) && (status === "waiting" || status === "pending"))
            .map(({ type, id, requestId }) => (type === "secret_request" ? id : requestId))
            .at(-1)
        return {
          messages: projection.messages.filter(({ role }) => role !== "system").slice(-recent),
          runs: projection.runs,
          request: Option.flatMap(Option.fromNullable(waiting), (id) => request(projection.turnItems, id)),
          plan: plan(projection.plans),
          pending: waitingOn(projection),
        } satisfies Detail
      }),

    /**
     * Does it to the thread under the id its step was given: sent again under
     * the same id, T3 Code does it once. Stopping goes for the run under way,
     * and fails when there's none.
     */
    run: (threadId: string, what: Command, commandId: string) =>
      Effect.gen(function* () {
        const { call } = yield* reach
        let runId: string | undefined
        if (what._tag === "Stop") {
          const { projection } = yield* bounded(threadId)
          runId = projection.runs.toSorted((a, b) => b.ordinal - a.ordinal).find(({ status }) => going.includes(status))?.id
          if (runId === undefined) return yield* new Server.Refusal({ tag: "NotRunning", message: "It isn't doing anything right now." })
        }
        return yield* call("orchestration.dispatchCommand", command(threadId, what, runId, commandId), Dispatched)
      }),

    message,

    /** Whether a message yapd sent is in the thread. */
    has: (threadId: string, messageId: string) => Effect.map(message(threadId, messageId), Option.isSome),

    /** How a message yapd sent went into the thread, when it says. */
    inputIntent: (threadId: string, messageId: string) => Effect.map(message(threadId, messageId), Option.flatMap(({ intent }) => intent)),

    /** How one of its runs went, or none when the thread doesn't have it. */
    ran: (threadId: string, runId: string) => Effect.map(bounded(threadId), ({ projection }) => ran(projection, runId)),

    /** The agent's own ids for the thread's conversations, which its hooks report as their session. */
    sessions: (threadId: string) => Effect.map(bounded(threadId), ({ projection }) => natives(projection.providerThreads)),

    /** Whether a run is still going in the thread, which a stop ends. */
    running: (threadId: string) => Effect.map(bounded(threadId), ({ projection }) => projection.runs.some(({ status }) => going.includes(status))),

    search: (query: string) =>
      Effect.gen(function* () {
        const { call } = yield* reach
        const trimmed = query.trim().slice(0, 200)
        if (trimmed.length < 2) return []
        const { matches } = yield* call("orchestration.searchThreads", { query: trimmed, limit: 20 }, Search)
        return matches
      }),

    usage: Effect.gen(function* () {
      const { call } = yield* reach
      const { providers } = yield* call("server.getConfig", {}, Limits)
      return providers
        .filter(({ enabled, status }) => enabled && status !== "disabled")
        .flatMap(({ instanceId, displayName, usageLimits }) =>
          usageLimits === undefined || usageLimits === null || usageLimits.windows.length === 0
            ? []
            : [
                {
                  provider: displayName ?? instanceId,
                  windows: usageLimits.windows.map(({ kind, label, windowDurationMins, usedPercent, resetsAt }) => ({
                    kind,
                    label,
                    minutes: windowDurationMins ?? undefined,
                    usedPercent,
                    resetsAt: resetsAt ?? undefined,
                  })),
                },
              ],
        ) satisfies Usage
    }),
  }
}

export type Actions = ReturnType<typeof make>
