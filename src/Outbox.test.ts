import { describe, expect, test } from "bun:test"
import { Effect, Option, Redacted, Schema, type Scope, TestClock, TestContext } from "effect"
import type { Notice } from "./Inbox.ts"
import * as Outbox from "./Outbox.ts"
import type { Heard } from "./Recent.ts"
import * as Store from "./Store.ts"
import * as Server from "./T3CodeServer.ts"
import * as T3CodeThreads from "./T3CodeThreads.ts"
import { type Listed, type Outgoing, type Sent, type Threads, ThreadsError } from "./Threads.ts"

const listed = (id: string, title: string, project = "yapd"): Listed => ({
  id,
  project,
  directory: "/tmp/yapd",
  title,
  branch: null,
  state: "running",
  needs: [],
  requestedAt: null,
  completedAt: null,
  updatedAt: "2026-09-30T10:00:00.000Z",
  error: null,
})

/** A machine's threads that answer every send the same way, and keep what they were sent. */
const fake = () => {
  const sent: Array<{ id: string; outgoing: Outgoing }> = []
  let answer: Sent | ThreadsError = "busy"
  const threads: Threads = {
    list: Effect.die("not called"),
    detail: () => Effect.die("not called"),
    opening: () => Effect.die("not called"),
    send: (id, outgoing) =>
      Effect.suspend(() => {
        sent.push({ id, outgoing })
        return answer instanceof ThreadsError ? Effect.fail(answer) : Effect.succeed(answer)
      }),
  }
  return { threads, sent, answers: (next: Sent | ThreadsError) => void (answer = next) }
}

/**
 * T3 Code as `T3CodeThreads` reaches it, with one idle thread that takes what's
 * posted but whose answer never gets back, and then stops on an approval.
 */
const t3code = () => {
  const thread = { id: "t1", projectId: "p1", title: "Fix retries", updatedAt: "2026-09-30T10:00:00.000Z", latestTurn: { state: "completed" }, session: { status: "ready" }, hasPendingApprovals: false }
  const messages: Array<{ id: string; role: string; text: string }> = []
  const transport: T3CodeThreads.Transport = {
    api: (path, schema, init) => {
      if (init?.method === "POST") {
        const { message } = JSON.parse(String(init.body))
        messages.push({ id: message.messageId, role: "user", text: message.text })
        thread.latestTurn = { state: "running" }
        thread.hasPendingApprovals = true
        return Effect.fail(new Server.Trouble({ reason: "T3 Code isn't answering.", cause: "timeout" }))
      }
      const answer = path === "/api/orchestration/shell" ? { projects: [{ id: "p1", title: "yapd" }], threads: [thread] } : { thread: { ...thread, messages } }
      return Effect.orDie(Schema.decodeUnknown(schema)(answer))
    },
  }
  return { threads: T3CodeThreads.threads(Option.some(Redacted.make("token")), () => Effect.succeed(transport)), messages }
}

// Lets the watcher catch up on what the test did, since the clock only moves when told to.
const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
const wait = (seconds: number) => TestClock.adjust(`${seconds} seconds`).pipe(Effect.zipRight(flush))

const held = (store: Store.Store["Type"]) =>
  store.transaction((database) =>
    database.query<{ command_id: string; state: string }, []>("select command_id, state from messages order by created_at").all(),
  )

interface Context {
  readonly store: Store.Store["Type"]
  readonly told: Array<Notice>
  readonly noted: Array<Heard>
  /** What the daemon was told to expect, before each try. */
  readonly expected: Array<string>
  readonly machines: Map<string, Threads>
}

const run = <A>(test: (context: Context) => Effect.Effect<A, unknown, Store.Store | Scope.Scope>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store.make(":memory:", Store.migrations)
      const told: Array<Notice> = []
      const noted: Array<Heard> = []
      const expected: Array<string> = []
      const machines = new Map<string, Threads>()
      return yield* test({ store, told, noted, expected, machines }).pipe(Effect.provideService(Store.Store, store))
    }).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
  )

const options = (context: Omit<Context, "store">): Outbox.Options => ({
  here: () => "rosie",
  threads: (machine) => Option.fromNullable(context.machines.get(machine)),
  tell: (notice) => Effect.sync(() => void context.told.push(notice)),
  note: (heard) => Effect.sync(() => void context.noted.push(heard)),
  expect: (text) => Effect.sync(() => void context.expected.push(text)),
})

const said = (told: Array<Notice>) => told.map(({ priority, spoken }) => ({ priority, spoken }))

/** Why a send failed, as it would be read out. */
const why = <A>(effect: Effect.Effect<A, ThreadsError | Store.StoreError>) =>
  Effect.map(Effect.flip(effect), (error) => (error._tag === "ThreadsError" ? error.reason : error.message))

describe("Outbox", () => {
  test("holds a message for a thread mid-turn and passes it on, as the same command, when the turn ends", () =>
    run((context) =>
      Effect.gen(function* () {
        const rosie = fake()
        context.machines.set("rosie", rosie.threads)
        const outbox = yield* Outbox.make(options(context))
        expect(yield* outbox.send("rosie", listed("t1", "Fix retries"), "Keep the API.")).toEqual({ _tag: "Held" })
        yield* flush
        // Tried again after 5 seconds, then 10: a thread that stays busy is asked less and less often.
        yield* wait(5)
        expect(rosie.sent.map(({ id }) => id)).toEqual(["t1", "t1"])
        yield* wait(5)
        expect(rosie.sent).toHaveLength(2)
        expect(context.told).toEqual([])

        rosie.answers("sent")
        yield* wait(5)
        const commandId = rosie.sent[0]?.outgoing.commandId ?? ""
        expect(commandId).toMatch(/^yapd:/)
        expect(rosie.sent.map(({ outgoing }) => outgoing.commandId)).toEqual([commandId, commandId, commandId])
        // Expected before every try, so its answer is heard however quick the turn that gives it.
        expect(context.expected).toEqual(["Keep the API.", "Keep the API.", "Keep the API."])
        expect(said(context.told)).toEqual([{ priority: "done", spoken: "Passed your message on to Fix retries in yapd now that it finished." }])
        // Noted under the notice's id, for the thread, so once it plays "tell it to" means this thread.
        expect(context.noted.map(({ id, thread, directory, message }) => ({ id, thread, directory, message }))).toEqual([
          { id: context.told[0]?.id ?? "", thread: { machine: "rosie", id: "t1" }, directory: "/tmp/yapd", message: "Keep the API." },
        ])
        expect(yield* held(context.store)).toEqual([{ command_id: commandId, state: "sent" }])

        // Nothing left to pass on, so nothing more is tried.
        yield* wait(60)
        expect(rosie.sent).toHaveLength(3)
      }),
    ))

  test("sends, expects and keeps a message as T3 Code takes it, without the slash that would run it as a command", () =>
    run((context) =>
      Effect.gen(function* () {
        const rosie = fake()
        context.machines.set("rosie", rosie.threads)
        const outbox = yield* Outbox.make(options(context))
        expect(yield* outbox.send("rosie", listed("t1", "Fix retries"), " /compact the notes")).toEqual({ _tag: "Held" })
        rosie.answers("sent")
        yield* wait(5)
        // The same text before every try, so the prompt the thread's hooks report is the one expected.
        expect(context.expected).toEqual(["compact the notes", "compact the notes"])
        expect(rosie.sent.map(({ outgoing }) => outgoing.text)).toEqual(["compact the notes", "compact the notes"])
        expect(context.noted.map(({ message }) => message)).toEqual(["compact the notes"])
      }),
    ))

  test("keeps a message whose first try didn't say whether it went, and tries the same ids again", () =>
    run((context) =>
      Effect.gen(function* () {
        const rig = fake()
        rig.answers(new ThreadsError({ reason: "rig isn't answering, so I don't know if it went through." }))
        context.machines.set("rig", rig.threads)
        const outbox = yield* Outbox.make(options(context))
        expect(yield* outbox.send("rig", listed("t1", "Fix retries", ""), "Keep the API.")).toEqual({
          _tag: "Pending",
          reason: "rig isn't answering, so I don't know if it went through.",
        })
        expect((yield* held(context.store)).map(({ state }) => state)).toEqual(["held"])
        rig.answers("sent")
        yield* wait(5)
        const commandId = rig.sent[0]?.outgoing.commandId ?? ""
        expect(rig.sent.map(({ outgoing }) => outgoing.commandId)).toEqual([commandId, commandId])
        expect(said(context.told)).toEqual([{ priority: "done", spoken: "Passed your message on to Fix retries on rig now that it finished." }])
      }),
    ))

  test("finds a message T3 Code took without saying so in the thread, and marks it sent rather than failed once the thread waits on the user", () =>
    run((context) =>
      Effect.gen(function* () {
        const rosie = t3code()
        context.machines.set("rosie", rosie.threads)
        const outbox = yield* Outbox.make(options(context))
        expect(yield* outbox.send("rosie", listed("t1", "Fix retries"), "Keep the API.")).toEqual({ _tag: "Pending", reason: "T3 Code isn't answering." })
        yield* wait(5)
        expect(rosie.messages.map(({ text }) => text)).toEqual(["Keep the API."])
        expect((yield* held(context.store)).map(({ state }) => state)).toEqual(["sent"])
        expect(said(context.told)).toEqual([{ priority: "done", spoken: "Passed your message on to Fix retries in yapd now that it finished." }])
      }),
    ))

  test("doesn't send to a thread waiting on the user in T3 Code, and says so", () =>
    run((context) =>
      Effect.gen(function* () {
        const rosie = fake()
        rosie.answers("waiting")
        context.machines.set("rosie", rosie.threads)
        const outbox = yield* Outbox.make(options(context))
        expect(yield* why(outbox.send("rosie", listed("t1", "Fix retries"), "Yes, go ahead."))).toBe(Outbox.waiting)
        expect((yield* held(context.store)).map(({ state }) => state)).toEqual(["failed"])
        expect(context.told).toEqual([])

        // Held while busy, then stopped on an approval: the user isn't there to hear it, so they're told.
        rosie.answers("busy")
        expect(yield* outbox.send("rosie", listed("t1", "Fix retries"), "Keep the API.")).toEqual({ _tag: "Held" })
        rosie.answers("waiting")
        yield* wait(5)
        expect((yield* held(context.store)).map(({ state }) => state)).toEqual(["failed", "failed"])
        expect(said(context.told)).toEqual([{ priority: "needs-you", spoken: `I couldn't pass your message on to Fix retries in yapd. ${Outbox.waiting}` }])
      }),
    ))

  test("gives up on a held message when its thread is gone, and says so", () =>
    run((context) =>
      Effect.gen(function* () {
        const rig = fake()
        context.machines.set("rig", rig.threads)
        const outbox = yield* Outbox.make(options(context))
        expect(yield* outbox.send("rig", listed("t1", "Fix retries"), "Keep the API.")).toEqual({ _tag: "Held" })
        rig.answers(new ThreadsError({ reason: "That thread was archived.", gone: true }))
        yield* wait(5)
        expect(said(context.told)).toEqual([
          { priority: "needs-you", spoken: "I couldn't pass your message on to Fix retries in yapd on rig. That thread was archived." },
        ])
        expect(context.noted.map(({ thread }) => thread)).toEqual([{ machine: "rig", id: "t1" }])
        expect((yield* held(context.store)).map(({ state }) => state)).toEqual(["failed"])
      }),
    ))

  test("keeps a second message behind the first, and passes them on one turn at a time", () =>
    run((context) =>
      Effect.gen(function* () {
        const rosie = fake()
        context.machines.set("rosie", rosie.threads)
        const outbox = yield* Outbox.make(options(context))
        expect(yield* outbox.send("rosie", listed("t1", "Fix retries"), "First.")).toEqual({ _tag: "Held" })
        yield* wait(1)
        expect(yield* outbox.send("rosie", listed("t1", "Fix retries"), "Second.")).toEqual({ _tag: "Held" })
        // The second wasn't tried: it would jump the queue. The first is tried again right away instead.
        rosie.answers("sent")
        yield* flush
        expect(rosie.sent.map(({ outgoing }) => outgoing.text)).toEqual(["First.", "First."])
        expect((yield* held(context.store)).map(({ state }) => state)).toEqual(["sent", "held"])
        yield* wait(5)
        expect(rosie.sent.at(-1)?.outgoing.text).toBe("Second.")
        expect((yield* held(context.store)).map(({ state }) => state)).toEqual(["sent", "sent"])
        expect(context.told).toHaveLength(2)
      }),
    ))

  test("sends here while another machine is still being waited on", () =>
    run((context) =>
      Effect.gen(function* () {
        const rosie = fake()
        rosie.answers("sent")
        context.machines.set("rosie", rosie.threads)
        context.machines.set("rig", { ...rosie.threads, send: () => Effect.never })
        const outbox = yield* Outbox.make(options(context))
        yield* Effect.fork(outbox.send("rig", listed("t1", "Fix retries"), "Slow."))
        yield* flush
        expect(yield* outbox.send("rosie", listed("t2", "Latency"), "Quick.")).toEqual({ _tag: "Sent" })
        expect(rosie.sent.map(({ outgoing }) => outgoing.text)).toEqual(["Quick."])
      }),
    ))

  test("picks up what was held before a restart, and keeps it while its machine can't be reached", () =>
    run((context) =>
      Effect.gen(function* () {
        yield* context.store.transaction((database) => {
          database.run(
            `insert into messages (command_id, message_id, machine, thread, title, project, directory, text, state, reason, created_at)
            values ('yapd:old', 'm1', 'rig', 't1', 'Fix retries', 'yapd', '/code/yapd', 'From before.', 'held', null, '1970-01-01T00:00:00.000Z')`,
          )
        })
        const rig = fake()
        rig.answers("sent")
        yield* Outbox.make(options(context))
        // Not reachable yet, so it's kept for later.
        yield* flush
        yield* wait(5)
        expect(rig.sent).toEqual([])
        expect((yield* held(context.store)).map(({ state }) => state)).toEqual(["held"])

        context.machines.set("rig", rig.threads)
        yield* wait(10)
        expect(rig.sent.map(({ outgoing }) => outgoing)).toEqual([{ commandId: "yapd:old", messageId: "m1", text: "From before." }])
        expect(context.told.map(({ spoken }) => spoken)).toEqual(["Passed your message on to Fix retries in yapd on rig now that it finished."])

        // Sent right away to a machine yapd doesn't know, or with nothing in it, a message fails before it's kept: the user is there to hear it.
        context.machines.delete("rig")
        const outbox = yield* Outbox.make({ ...options(context), every: "1 hour" })
        expect(yield* why(outbox.send("rig", listed("t2", "Latency"), "Late."))).toBe("I don't know how to reach rig.")
        expect(yield* why(outbox.send("rosie", listed("t2", "Latency"), " / "))).toBe("I didn't catch what to send.")
        expect((yield* held(context.store)).map(({ state }) => state)).toEqual(["sent"])
      }),
    ))

  test("drops a message held for a day, and says why it couldn't go", () =>
    run((context) =>
      Effect.gen(function* () {
        const rig = fake()
        context.machines.set("rig", rig.threads)
        const outbox = yield* Outbox.make({ ...options(context), every: "1 hour" })
        expect(yield* outbox.send("rig", listed("t1", "Fix retries"), "Keep the API.")).toEqual({ _tag: "Held" })
        context.machines.delete("rig")
        yield* wait(23 * 3600)
        expect((yield* held(context.store)).map(({ state }) => state)).toEqual(["held"])
        yield* wait(3600)
        expect((yield* held(context.store)).map(({ state }) => state)).toEqual(["failed"])
        expect(said(context.told)).toEqual([
          { priority: "needs-you", spoken: "I dropped your message for Fix retries in yapd on rig: it's been held for a day. I don't know how to reach rig." },
        ])
      }),
    ))
})
