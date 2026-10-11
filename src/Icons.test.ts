import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema, type Scope, Stream, TestClock, TestContext } from "effect"
import * as Icons from "./Icons.ts"
import * as T3Actions from "./T3Actions.ts"
import type * as Server from "./T3CodeServer.ts"
import type * as T3Live from "./T3Live.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)))

/** Lets the fibers catch up, since the clock only moves when told to. */
const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))

const project = (overrides: Partial<T3Live.Project> = {}): T3Live.Project => ({ id: "p-int", title: "integration", workspaceRoot: "/code/integration", ...overrides })

/**
 * A machine's T3 Code that serves a project's icon under `file`, or none,
 * keeping what it was asked: by which folder, and which files were fetched.
 */
const serving = (name: string, given: { file: string; bytes?: Uint8Array; type?: string }) => {
  const asked: Array<string> = []
  const reach: Effect.Effect<Server.Transport, Server.Trouble> = Effect.succeed({
    api: (() => Effect.die("not expected")) as Server.Transport["api"],
    call: (<A, I>(method: string, payload: unknown, schema: Schema.Schema<A, I>) =>
      Effect.suspend(() => {
        const { resource } = payload as { readonly resource: { readonly _tag: string; readonly cwd: string } }
        asked.push(`${name} ${method} ${resource._tag} ${resource.cwd}`)
        return Schema.decodeUnknown(schema)({ relativeUrl: `/api/assets/signed-token-${asked.length}/${encodeURIComponent(given.file)}`, expiresAt: 0 }).pipe(Effect.orDie)
      })) as Server.Transport["call"],
    asset: (path) =>
      Effect.sync(() => {
        asked.push(`${name} fetch ${decodeURIComponent(path.split("/").at(-1) ?? "")}`)
        return { bytes: given.bytes ?? new Uint8Array([137, 80, 78, 71]), type: given.type ?? "image/png" }
      }),
  })
  return { actions: T3Actions.make(reach), asked, serves: (file: string, bytes?: Uint8Array) => { given.file = file; if (bytes !== undefined) given.bytes = bytes } }
}

describe("Icons", () => {
  test("a monogram is made from a project's name as T3 Code makes it, letters and colour alike", () => {
    // As T3 Code's own functions, run on these names, give them.
    const vectors: ReadonlyArray<readonly [string, string, string]> = [
      ["yapd", "YD", "pink"],
      ["integration", "IN", "indigo"],
      ["Tezos 2", "T2", "blue"],
      ["integration-connectors", "IC", "cyan"],
      ["", "PR", "fuchsia"],
      ["🦀", "PR", "green"],
      ["Ünïcode", "ÜE", "pink"],
      ["std", "SD", "red"],
      ["Mina SSV2", "MS", "lime"],
      ["a", "AA", "emerald"],
    ]
    for (const [name, text, color] of vectors) expect(Icons.monogram(name)).toEqual({ text, color: color as Icons.Color })
  })

  test("what he chose comes first: a monogram, an emoji, a Lucide glyph drawn as a monogram in its colour, then the image, then the name's monogram", async () => {
    const t3 = serving("Rosie", { file: "vabc123-favicon.svg" })
    const result = await run(
      Effect.gen(function* () {
        const icons = yield* Icons.make({ actions: () => Option.some(t3.actions) })
        const chosen = (projectIcon: unknown) => icons.icon("Rosie", project({ projectIcon }))
        const first = {
          monogram: yield* chosen({ kind: "monogram", text: "TZ", color: "teal" }),
          emoji: yield* chosen({ kind: "emoji", emoji: "🦀" }),
          lucide: yield* chosen({ kind: "lucide", name: "rocket", color: "violet" }),
          // A kind T3 Code adds, or one it sends broken, is no choice at all.
          unknown: yield* chosen({ kind: "sticker", url: "https://example.com/x.png" }),
          broken: yield* chosen({ kind: "monogram", text: "TZ", color: "chartreuse" }),
        }
        yield* flush
        return { first, then: yield* chosen(null), image: yield* icons.image("Rosie", "p-int") }
      }),
    )
    expect(result.first).toEqual({
      monogram: { kind: "monogram", text: "TZ", color: "teal" },
      emoji: { kind: "emoji", emoji: "🦀", text: "IN", color: "indigo" },
      lucide: { kind: "monogram", text: "IN", color: "violet" },
      unknown: { kind: "monogram", text: "IN", color: "indigo" },
      broken: { kind: "monogram", text: "IN", color: "indigo" },
    })
    expect(result.then).toEqual({ kind: "image", url: "/projects/Rosie/p-int/icon", revision: expect.stringMatching(/^[0-9a-f]{16}$/), text: "IN", color: "indigo" })
    // Never T3 Code's own path to it, which is a key to the image while it lasts.
    expect(JSON.stringify(result)).not.toMatch(/api\/assets|signed-token/)
    expect(Option.map(result.image, ({ type, bytes }) => ({ type, bytes: [...bytes] }))).toEqual(Option.some({ type: "image/png", bytes: [137, 80, 78, 71] }))
    // Only asked once, by the project's own folder, while the first was being fetched.
    expect(t3.asked).toEqual(["Rosie assets.createUrl project-favicon /code/integration", "Rosie fetch vabc123-favicon.svg"])
  })

  test("T3 Code is asked by the project's own folder, never a worktree's; a project with no image is asked again ten minutes on, one with an image half an hour on, fetched again only when it changed", async () => {
    const t3 = serving("Rosie", { file: T3Actions.noIcon })
    const result = await run(
      Effect.gen(function* () {
        const icons = yield* Icons.make({ actions: () => Option.some(t3.actions) })
        let changes = 0
        yield* Effect.forkScoped(Stream.runForEach(icons.changes, () => Effect.sync(() => void changes++)))
        const look = Effect.zipLeft(icons.icon("Rosie", project()), flush)
        const kinds: Array<string> = []
        kinds.push((yield* look).kind)
        // He adds an icon: not asked again until ten minutes are up.
        t3.serves("v111-favicon.png")
        yield* TestClock.adjust("9 minutes")
        kinds.push((yield* look).kind)
        yield* TestClock.adjust("1 minute")
        kinds.push((yield* look).kind, (yield* look).kind)
        // The same image, half an hour on, isn't fetched again; a new one is.
        yield* TestClock.adjust("30 minutes")
        yield* look
        t3.serves("v222-favicon.png", new Uint8Array([1, 2, 3]))
        yield* TestClock.adjust("30 minutes")
        yield* look
        const changed = yield* look
        return { kinds, changed, changes, asked: t3.asked }
      }),
    )
    expect(result.kinds).toEqual(["monogram", "monogram", "monogram", "image"])
    expect(result.changed.kind).toBe("image")
    expect(result.changes).toBe(2)
    expect(result.asked).toEqual([
      "Rosie assets.createUrl project-favicon /code/integration",
      "Rosie assets.createUrl project-favicon /code/integration",
      "Rosie fetch v111-favicon.png",
      "Rosie assets.createUrl project-favicon /code/integration",
      "Rosie assets.createUrl project-favicon /code/integration",
      "Rosie fetch v222-favicon.png",
    ])
  })

  test("rig's projects are asked of rig's T3 Code, and served under rig", async () => {
    const here = serving("Rosie", { file: T3Actions.noIcon })
    const rig = serving("rig", { file: "v9-favicon.ico", type: "image/x-icon" })
    const result = await run(
      Effect.gen(function* () {
        const icons = yield* Icons.make({ actions: (machine) => Option.some(machine === "rig" ? rig.actions : here.actions) })
        yield* icons.icon("rig", project({ workspaceRoot: "/home/laurent/code/integration" }))
        yield* flush
        return { icon: yield* icons.icon("rig", project({ workspaceRoot: "/home/laurent/code/integration" })), here: yield* icons.image("Rosie", "p-int") }
      }),
    )
    expect(result.icon).toMatchObject({ kind: "image", url: "/projects/rig/p-int/icon" })
    expect(result.here).toEqual(Option.none())
    expect(here.asked).toEqual([])
    expect(rig.asked).toEqual(["rig assets.createUrl project-favicon /home/laurent/code/integration", "rig fetch v9-favicon.ico"])
  })

  test("what T3 Code sends that isn't an image is never served as one", async () => {
    const t3 = serving("Rosie", { file: "v1-favicon.svg", type: "text/html" })
    const result = await run(
      Effect.gen(function* () {
        const icons = yield* Icons.make({ actions: () => Option.some(t3.actions) })
        yield* icons.icon("Rosie", project())
        yield* flush
        return { icon: yield* icons.icon("Rosie", project()), image: yield* icons.image("Rosie", "p-int") }
      }),
    )
    expect(result).toEqual({ icon: { kind: "monogram", text: "IN", color: "indigo" }, image: Option.none() })
  })
})
