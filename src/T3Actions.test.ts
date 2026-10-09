import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import * as T3Actions from "./T3Actions.ts"
import * as Server from "./T3CodeServer.ts"

const approval = {
  type: "approval_request",
  status: "waiting",
  requestId: "r1",
  requestKind: "command",
  prompt: "Run git push origin main",
  options: [
    { decision: "accept", label: "Yes" },
    { decision: "decline", label: "No" },
  ],
}

const question = {
  type: "user_input_request",
  status: "waiting",
  requestId: "r2",
  questions: [{ id: "Which database?", header: "Storage", question: "Which database?", options: [{ label: "SQLite" }, { label: "Postgres" }] }],
}

/**
 * A T3 Code that answers from what it's given, the thread's last turns as
 * `bounded`, and the whole of it as `whole`, or too slow to; and keeps what it
 * was sent, and where it was read.
 */
const transport = (bounded: object, whole: object | "fails" = bounded) => {
  const sent: Array<{ method: string; payload: Record<string, unknown> }> = []
  const read: Array<string> = []
  const reach: Effect.Effect<Server.Transport, Server.Trouble> = Effect.succeed({
    api: (<A, I>(path: string, schema: Schema.Schema<A, I>) =>
      Effect.suspend(() => {
        read.push(path)
        const answer = path.endsWith("/bounded") ? bounded : whole
        return answer === "fails" ? Effect.fail(new Server.Trouble({ reason: "T3 Code isn't answering." })) : Schema.decodeUnknown(schema)(answer).pipe(Effect.orDie)
      })) as Server.Transport["api"],
    call: (<A, I>(method: string, payload: unknown, schema: Schema.Schema<A, I>) =>
      Effect.sync(() => sent.push({ method, payload: payload as Record<string, unknown> })).pipe(
        Effect.zipRight(Schema.decodeUnknown(schema)({ sequence: 1 }).pipe(Effect.orDie)),
      )) as Server.Transport["call"],
  })
  return { actions: T3Actions.make(reach), sent, read }
}

const projection = (overrides: object = {}) => ({
  projection: {
    runs: [
      { id: "run-1", status: "completed", ordinal: 1 },
      { id: "run-2", status: "running", ordinal: 2 },
    ],
    messages: [
      { role: "user", text: "Fix it.", createdAt: "a" },
      { role: "system", text: "noise", createdAt: "b" },
      { role: "assistant", text: "Pushing now.", createdAt: "c" },
    ],
    turnItems: [approval, { type: "assistant_message", text: "x" }],
    plans: [{ kind: "todo_list", status: "active", steps: [{ text: "Push", status: "running" }] }],
    ...overrides,
  },
})

describe("T3Actions", () => {
  test("reads what a thread waits on, in words that can be said", () => {
    expect(T3Actions.request([approval], "r1")).toEqual(
      Option.some({ _tag: "Approval", id: "r1", what: "Run git push origin main", kind: "command", decisions: approval.options }),
    )
    expect(Option.map(T3Actions.request([question], "r2"), (found) => found._tag)).toEqual(Option.some("Question"))
    expect(T3Actions.request([approval], "other")).toEqual(Option.none())
    // An option whose answer isn't its label answers with its value.
    const form = T3Actions.request(
      [{ ...question, questions: [{ id: "env", question: "Which environment?", options: [{ label: "Production", value: "prod" }, { label: "Staging" }] }] }],
      "r2",
    )
    const options = Option.match(form, { onNone: () => [], onSome: (found) => (found._tag === "Question" ? found.questions[0]!.options : []) })
    expect(options.map(T3Actions.choice)).toEqual(["prod", "Staging"])
    // An approval that names no decisions takes the usual ones.
    const bare = T3Actions.request([{ ...approval, options: undefined }], "r1")
    expect(Option.map(bare, (found) => (found._tag === "Approval" ? found.decisions.map(({ decision }) => decision) : []))).toEqual(
      Option.some(["accept", "acceptForSession", "decline"]),
    )
    // What it would run comes from the command it shares the agent's id with.
    const command = { type: "command_execution", status: "pending", nativeItemRef: { nativeId: "toolu_1" }, input: "git push --force origin main" }
    const pushing = T3Actions.request([command, { ...approval, prompt: "Push the branch", nativeItemRef: { nativeId: "toolu_1" } }], "r1")
    expect(Option.map(pushing, (found) => (found._tag === "Approval" ? [found.what, found.command] : []))).toEqual(
      Option.some(["Push the branch", "git push --force origin main"]),
    )
    // Cut short to be said, a long one is still kept whole, to tell by all of it whether it's risky; one the thread doesn't show has neither.
    const long = `echo '${"a".repeat(650)}'; rm -rf /tmp/example-data`
    const cleaning = T3Actions.request([{ ...command, input: long }, { ...approval, nativeItemRef: { nativeId: "toolu_1" } }], "r1")
    expect(Option.map(cleaning, (found) => (found._tag === "Approval" ? [found.command?.length, found.whole] : []))).toEqual(Option.some([600, long]))
    expect(Option.map(T3Actions.request([approval], "r1"), (found) => (found._tag === "Approval" ? [found.command, found.whole] : []))).toEqual(
      Option.some([undefined, undefined]),
    )
    // One too long to look through, like a tool given a whole file, is said as it starts, and taken for unread.
    const huge = T3Actions.request([{ ...command, input: `echo '${"a".repeat(30_000)}'` }, { ...approval, nativeItemRef: { nativeId: "toolu_1" } }], "r1")
    expect(Option.map(huge, (found) => (found._tag === "Approval" ? [found.command?.length, found.whole] : []))).toEqual(Option.some([600, undefined]))
    // A tool's input is looked through as the tool gets it, each line on its own, and is unread when T3 Code sent only how it starts.
    const tool = (input: unknown) =>
      Option.map(
        T3Actions.request([{ type: "dynamic_tool", status: "running", toolName: "Monitor", input, nativeItemRef: { nativeId: "toolu_1" } }, { ...approval, nativeItemRef: { nativeId: "toolu_1" } }], "r1"),
        (found) => (found._tag === "Approval" ? [found.command, found.whole] : []),
      )
    expect(tool({ command: "cd build\nrm -rf ~/work", timeout: 30 })).toEqual(
      Option.some(['Monitor {"command":"cd build\\nrm -rf ~/work","timeout":30}', "Monitor\ncommand\ncd build\nrm -rf ~/work\ntimeout\n30"]),
    )
    expect(tool({ summary: '{"command":"echo aaaa…', truncated: true })).toEqual(Option.some(['Monitor {"summary":"{\\"command\\":\\"echo aaaa…","truncated":true}', undefined]))
    // A command given as a list of words is one line, as it runs, and an input sent as JSON in a string is read as what that holds.
    expect(Option.map(tool({ args: ["git", "push", "origin", "main", "--force"] }), ([, whole]) => whole)).toEqual(Option.some("Monitor\nargs\ngit push origin main --force"))
    expect(Option.map(tool('{"command":"cd build\\nrm -rf ~/work"}'), ([, whole]) => whole)).toEqual(Option.some("Monitor\ncommand\ncd build\nrm -rf ~/work"))
    // A command given apart from its words is the one line it runs as too, after the rest, and its words are never a line of their own.
    expect(Option.map(tool({ command: "rm", args: ["-rf", "~/work"] }), ([, whole]) => whole)).toEqual(Option.some("Monitor\ncommand\nrm\nargs\nrm -rf ~/work"))
    expect(Option.map(tool({ cmd: "git", argv: "push --force" }), ([, whole]) => whole)).toEqual(Option.some("Monitor\ncmd\ngit\nargv\ngit push --force"))
    expect(Option.map(tool({ command: "git", args: ["log", "--grep", "clean", "-f"] }), ([, whole]) => whole)).toEqual(
      Option.some("Monitor\ncommand\ngit\nargs\ngit log --grep clean -f"),
    )
    // However what it runs is named, as a program or an executable too.
    expect(Option.map(tool({ program: "rm", args: ["-rf", "~/work"] }), ([, whole]) => whole)).toEqual(Option.some("Monitor\nprogram\nrm\nargs\nrm -rf ~/work"))
    expect(Option.map(tool({ executable: "/bin/rm", arguments: ["-rf", "~/work"] }), ([, whole]) => whole)).toEqual(
      Option.some("Monitor\nexecutable\n/bin/rm\narguments\n/bin/rm -rf ~/work"),
    )
    // A secret goes by its own item's id, which is what the thread says it waits on.
    const secret = { type: "secret_request", id: "turn-item:secret-request:t1:deploy", status: "waiting", label: "Deploy key", reason: "To deploy", secretStatus: "pending" }
    expect(T3Actions.request([secret], "turn-item:secret-request:t1:deploy")).toEqual(
      Option.some({ _tag: "Secret", id: "turn-item:secret-request:t1:deploy", label: "Deploy key" }),
    )
    // A question that asks him to type in a secret, as Codex marks one and T3 Code passes on as any other, is a secret too; one with options isn't.
    const typed = (header: string, asked: string, options: ReadonlyArray<{ readonly label: string; readonly description: string }> = []) =>
      Option.map(T3Actions.request([{ ...question, questions: [{ id: "k", header, question: asked, options }] }], "r2"), (found) => (found._tag === "Secret" ? found.label : found._tag))
    expect(typed("Question", "Paste your OpenAI API key.")).toEqual(Option.some("API key"))
    expect(typed("Login", "What's the database password?")).toEqual(Option.some("password"))
    expect(typed("GitHub token", "So I can open the PR.")).toEqual(Option.some("GitHub token"))
    // However it's written: as code names it, in a word that's only one when he's asked to give it, or as a code he's sent.
    for (const [asked, label] of [
      ["Please provide OPENAI_API_KEY so I can run the evals.", "OPENAI_API_KEY"],
      ["What is the value of STRIPE_SECRET_KEY?", "STRIPE_SECRET_KEY"],
      ["Provide your AWS_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"],
      ["Enter the HF_TOKEN", "HF_TOKEN"],
      ["Please provide the DATABASE_URL", "DATABASE_URL"],
      ["What's your OpenAI key?", "key"],
      ["Enter your Stripe key", "key"],
      ["Please provide your Hugging Face token", "token"],
      ["Enter the token for the registry", "token"],
      ["What is your GitHub PAT?", "PAT"],
      ["What's your PIN?", "PIN"],
      ["What is your sudo pwd?", "pwd"],
      ["Paste the session cookie", "cookie"],
      ["What's your npm OTP?", "OTP"],
      ["Provide the JWT", "JWT"],
      ["Enter the verification code sent to your phone", "verification code"],
      ["Provide the connection string for Postgres", "connection string"],
      ["What's the database URL, with its user and pass?", "database URL"],
      ["What's the webhook signing secret?", "secret"],
      ["Enter the code sent to your phone.", "code"],
      ["What's the SMS code?", "SMS code"],
      ["What's the wallet's recovery phrase?", "recovery phrase"],
      ["Give me the 12 words for the test wallet", "12 words"],
      ["Paste the Slack webhook URL.", "webhook URL"],
      ["Paste the Slack webhook.", "webhook"],
      ["Stripe live key?", "key"],
      ["What's the bearer for the API?", "bearer"],
      ["What's the DB connection URI?", "connection URI"],
      ["What's the admin login for the staging dashboard?", "login"],
      ["Paste the contents of service-account.json", "service-account"],
      ["What should I put in the Authorization header?", "Authorization header"],
      ["I need the value for SENTRY_AUTH so I can upload source maps", "SENTRY_AUTH"],
      ["What's GOOGLE_APPLICATION_CREDENTIALS?", "GOOGLE_APPLICATION_CREDENTIALS"],
      ["What's REDIS_URL?", "REDIS_URL"],
    ] as const) {
      expect(typed("Question", asked)).toEqual(Option.some(label))
    }
    // A token or a key he's asked to pick, like a coin, is a question.
    expect(typed("Question", "Which token should the indexer track first?")).toEqual(Option.some("Question"))
    expect(typed("Question", "Should I sort by the date key or the name key?")).toEqual(Option.some("Question"))
    expect(typed("Question", "What should the new branch be called?")).toEqual(Option.some("Question"))
    expect(typed("Keys", "Keep the API keys in the vault?", [{ label: "Yes", description: "Yes" }, { label: "No", description: "No" }])).toEqual(Option.some("Question"))
  })

  test("a question's response mode and required parts are read from its card", () => {
    const read = (card: object) =>
      Option.match(T3Actions.request([{ ...question, ...card }], "r2"), {
        onNone: () => undefined,
        onSome: (found) => (found._tag === "Question" ? { mode: found.mode, required: found.questions.map(({ required }) => required) } : undefined),
      })
    // Claude's go straight to it, and every part needs an answer unless the card says otherwise.
    expect(read({})).toEqual({ mode: "live", required: [true] })
    // Codex's asked in its reply are answered as a message to the thread.
    const parts = [
      { id: "0", question: "Which network first?", required: true },
      { id: "1", question: "Anything to skip?", required: false },
    ]
    expect(read({ responseMode: "message", questions: parts })).toEqual({ mode: "message", required: [true, false] })
  })

  test("takes what he'd send for a secret when it looks like one, however the question it answers was worded", () => {
    for (const said of [
      "Four two seven one nine three.",
      "4 2 7 1 9 3",
      "4-2-7-1-9-3",
      "427193",
      "The PIN is 4271.",
      "sk proj one two three",
      "sk-proj-abc123",
      "ghp_abcdef123",
      "xoxb-1234-abcd",
      "AKIAIOSFODNN7EXAMPLE",
      "The key is hunter2.",
      "a8f3k2l9x0q7w5e1r4",
    ]) {
      expect([said, T3Actions.revealing(said)]).toEqual([said, true])
    }
    // A port, a year, a PR number, a version or a name isn't.
    for (const said of ["No.", "Use port 8080.", "Target the 2026 release.", "PR 4271 please", "Yes, bump it to 1.2.3.", "Call it fee-tables-v2", "Two or three of them."]) {
      expect([said, T3Actions.revealing(said)]).toEqual([said, false])
    }
  })

  test("gives back a thread's last messages, its plan and what it waits on", async () => {
    const { actions } = transport(projection())
    const detail = await Effect.runPromise(actions.detail("t1"))
    expect(detail.messages.map(({ text }) => text)).toEqual(["Fix it.", "Pushing now."])
    expect(Option.map(detail.request, ({ id }) => id)).toEqual(Option.some("r1"))
    expect(detail.plan).toEqual(Option.some("- [running] Push"))
    expect(detail.pending).toEqual(["r1"])
    // What it still waits on, by T3 Code's own record of each when it keeps one, even one hidden behind a newer one.
    const both = transport(projection({ runtimeRequests: [{ id: "r0", status: "pending" }, { id: "r1", status: "resolved" }, { id: "r2", status: "pending" }] }))
    expect((await Effect.runPromise(both.actions.detail("t1"))).pending).toEqual(["r0", "r2"])
    const settled = transport(projection({ turnItems: [{ ...approval, status: "completed" }] }))
    expect((await Effect.runPromise(settled.actions.detail("t1"))).request).toEqual(Option.none())
  })

  test("stops the run under way, and holds what's queued behind it", async () => {
    const { actions, sent } = transport(projection())
    await Effect.runPromise(actions.run("t1", { _tag: "Stop" }, "yapd:stop"))
    expect(sent).toEqual([
      {
        method: "orchestration.dispatchCommand",
        payload: { commandId: "yapd:stop", threadId: "t1", type: "run.interrupt", runId: "run-2", holdQueue: true },
      },
    ])
    const idle = transport(projection({ runs: [{ id: "run-1", status: "completed", ordinal: 1 }] }))
    expect(await Effect.runPromise(Effect.flip(idle.actions.run("t1", { _tag: "Stop" }, "yapd:stop")))).toMatchObject({ _tag: "Refusal" })
    expect(idle.sent).toEqual([])
  })

  test("finds a message it sent by its id, how it went in, the run it waits in, held or not, and the run whose turn it went into", async () => {
    const queued = projection({
      runs: [
        { id: "run-2", status: "running", ordinal: 2, userMessageId: "m-2" },
        { id: "run-3", status: "queued", ordinal: 3, userMessageId: "m-3" },
        { id: "run-5", status: "queued", ordinal: 5, userMessageId: "m-5", queueHeld: true },
        // Taken out of the queue into the turn under way, which cancels the run it waited in.
        { id: "run-6", status: "cancelled", ordinal: 6, userMessageId: "m-6" },
      ],
      messages: [{ id: "m-2", role: "user", text: "Fix it.", createdAt: "a" }],
      turnItems: [
        { type: "user_message", messageId: "m-4", inputIntent: "steer", status: "completed", runId: "run-2" },
        { type: "user_message", messageId: "m-6", inputIntent: "promoted_queued_to_steer", status: "completed", runId: "run-2" },
        // Steered into a run the read doesn't have.
        { type: "user_message", messageId: "m-7", inputIntent: "steer", status: "completed", runId: "run-1-gone" },
      ],
    })
    const { actions } = transport(queued)
    const found = (messageId: string) =>
      Effect.runPromise(
        Effect.map(
          actions.message("t1", messageId),
          Option.map(({ intent, run, into }) => ({ intent: Option.getOrNull(intent), run: Option.getOrNull(run), into: Option.getOrNull(into) })),
        ),
      )
    expect(await found("m-3")).toEqual(Option.some({ intent: "queued_turn", run: { id: "run-3", status: "queued", held: false }, into: null }))
    // In a queue a stop put on hold.
    expect(await found("m-5")).toEqual(Option.some({ intent: "queued_turn", run: { id: "run-5", status: "queued", held: true }, into: null }))
    // Steered in, even from the queue, it's in the turn T3 Code names on it, never the run it waited in.
    expect(await found("m-4")).toEqual(Option.some({ intent: "steer", run: null, into: { id: "run-2", status: "running" } }))
    expect(await found("m-6")).toEqual(
      Option.some({ intent: "promoted_queued_to_steer", run: { id: "run-6", status: "cancelled", held: false }, into: { id: "run-2", status: "running" } }),
    )
    expect(await found("m-7")).toEqual(Option.some({ intent: "steer", run: null, into: null }))
    // A run it started that has no turn item yet, as right after it went in: a turn of its own.
    expect(await found("m-2")).toEqual(Option.some({ intent: "turn_start", run: { id: "run-2", status: "running", held: false }, into: null }))
    expect(await Effect.runPromise(actions.has("t1", "m-9"))).toBe(false)
  })

  test("traces a message the thread's last turns show only by the run it waited in, cancelled, through the whole thread, read once, and only then", async () => {
    const whole = projection({
      runs: [
        { id: "run-1", status: "completed", ordinal: 1, userMessageId: "m-1" },
        { id: "run-2", status: "cancelled", ordinal: 2, userMessageId: "m-2" },
        { id: "run-3", status: "cancelled", ordinal: 3, userMessageId: "m-3" },
        { id: "run-4", status: "completed", ordinal: 4, userMessageId: "m-4" },
      ],
      messages: [
        // Moved from the queue into the turn under way, it's that turn's.
        { id: "m-2", role: "user", text: "Open a PR.", createdAt: "2026-10-08T22:01:00.000Z", runId: "run-1" },
        // Taken out of the queue, it names the run it waited in.
        { id: "m-3", role: "user", text: "Rename it.", createdAt: "2026-10-08T22:02:00.000Z", runId: "run-3" },
      ],
      turnItems: [{ type: "user_message", messageId: "m-2", inputIntent: "promoted_queued_to_steer", runId: "run-1" }],
    })
    // Enough turns since have pushed every message and turn item out of the bounded read, which keeps every run.
    const bounded = projection({ runs: whole.projection.runs, messages: [], turnItems: [] })
    const traced = async (messageId: string, reads = transport(bounded, whole)) => {
      const found = await Effect.runPromise(
        Effect.map(
          reads.actions.traced("t1", messageId),
          Option.map(({ intent, run, into }) => ({ intent: Option.getOrNull(intent), run: Option.getOrNull(run)?.status, into: Option.getOrNull(into)?.id })),
        ),
      )
      return { found, read: reads.read.map((path) => path.replace("/api/orchestration/threads/t1", "") || "whole") }
    }
    expect(await traced("m-2")).toEqual({ found: Option.some({ intent: "promoted_queued_to_steer", run: "cancelled", into: "run-1" }), read: ["/bounded", "whole"] })
    expect(await traced("m-3")).toEqual({ found: Option.some({ intent: null, run: "cancelled", into: "run-3" }), read: ["/bounded", "whole"] })
    // Its run not cancelled, it says what came of it, so the bounded read is enough.
    expect(await traced("m-4")).toEqual({ found: Option.some({ intent: "turn_start", run: "completed", into: undefined }), read: ["/bounded"] })
    // Its message still in the bounded read, it's found there.
    expect(await traced("m-3", transport(whole, "fails"))).toEqual({ found: Option.some({ intent: null, run: "cancelled", into: "run-3" }), read: ["/bounded"] })
    // The whole thread too slow to read, it's taken as neither.
    expect(await Effect.runPromise(Effect.flip(transport(bounded, "fails").actions.traced("t1", "m-2")))).toMatchObject({ _tag: "Trouble" })
  })

  test("sends what the app sends", () => {
    const send = (how: T3Actions.When) => T3Actions.command("t1", { _tag: "Send", text: "Merge it.", messageId: "m", how }, undefined, "c")
    expect(send("now")).toEqual({
      commandId: "c",
      threadId: "t1",
      type: "message.dispatch",
      messageId: "m",
      text: "Merge it.",
      createdBy: "user",
      creationSource: "web",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      deliveryIntent: "auto",
    })
    // After the turn under way, it goes in T3 Code's own queue, as the app's queue button sends it.
    expect(send("after")).toMatchObject({ dispatchMode: { type: "queue_after_active" } })
    expect(send("after")).not.toHaveProperty("deliveryIntent")
    // In place of the turn under way, it goes once yapd has stopped it, never as T3 Code's own restart, which it turns down in too many ordinary states.
    expect(send("restart")).toMatchObject({ dispatchMode: { type: "start_immediately" }, deliveryIntent: "auto" })
    expect(T3Actions.command("t1", { _tag: "Resume" }, undefined, "c")).toEqual({ commandId: "c", threadId: "t1", type: "queue.resume" })
    expect(T3Actions.command("t1", { _tag: "Cancel", runId: "run-3" }, undefined, "c")).toEqual({ commandId: "c", threadId: "t1", type: "queued-run.cancel", runId: "run-3" })
    expect(T3Actions.command("t1", { _tag: "Decide", requestId: "r1", decision: "accept" }, undefined, "c")).toEqual({
      commandId: "c",
      threadId: "t1",
      type: "runtime-request.respond",
      requestId: "r1",
      decision: "accept",
    })
    expect(T3Actions.command("t1", { _tag: "Answer", requestId: "r2", answers: { "Which database?": "SQLite" } }, undefined, "c")).toMatchObject({
      answers: { "Which database?": "SQLite" },
    })
    expect(T3Actions.command("t1", { _tag: "Rename", title: "Loader fix" }, undefined, "c")).toMatchObject({ type: "thread.metadata.update", title: "Loader fix" })
  })
})
