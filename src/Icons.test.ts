import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema, type Scope, TestContext } from "effect"
import * as Icons from "./Icons.ts"
import * as T3Actions from "./T3Actions.ts"
import * as Server from "./T3CodeServer.ts"
import type * as T3Live from "./T3Live.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)))

/** Lets the fibers catch up, since the clock only moves when told to. */
const flush = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))

const project = (overrides: Partial<T3Live.Project> = {}): T3Live.Project => ({ id: "p-int", title: "integration", workspaceRoot: "/code/integration", ...overrides })

/** A machine's T3 Code that serves a project's icon under `file`, as `type`. */
const serving = (given: { file: string; type?: string }) => {
  const reach: Effect.Effect<Server.Transport, Server.Trouble> = Effect.succeed({
    api: (() => Effect.die("not expected")) as Server.Transport["api"],
    call: (<A, I>(_method: string, _payload: unknown, schema: Schema.Schema<A, I>) =>
      Schema.decodeUnknown(schema)({ relativeUrl: `/api/assets/signed-token/${encodeURIComponent(given.file)}`, expiresAt: 0 }).pipe(Effect.orDie)) as Server.Transport["call"],
    asset: () => Effect.succeed({ bytes: new Uint8Array([137, 80, 78, 71]), type: given.type ?? "image/png" }),
  })
  return { actions: T3Actions.make(reach) }
}

describe("Icons", () => {
  test("a monogram is made from a project's name as T3 Code makes it, letters and colour alike", () => {
    // As T3 Code's own functions, run on these names, give them.
    const vectors: ReadonlyArray<readonly [string, string, string]> = [
      ["yapd", "YD", "pink"],
      ["Tezos 2", "T2", "blue"],
      ["", "PR", "fuchsia"],
      ["Ünïcode", "ÜE", "pink"],
    ]
    for (const [name, text, color] of vectors) expect(Icons.monogram(name)).toEqual({ text, color: color as Icons.Color })
  })

  test("a Lucide glyph is drawn as a monogram in its colour, a choice T3 Code sends broken is none, then the image, never by T3 Code's path", async () => {
    const t3 = serving({ file: "vabc123-favicon.svg" })
    const result = await run(
      Effect.gen(function* () {
        const icons = yield* Icons.make({ actions: () => Option.some(t3.actions) })
        const chosen = (projectIcon: unknown) => icons.icon("Rosie", project({ projectIcon }))
        const first = {
          lucide: yield* chosen({ kind: "lucide", name: "rocket", color: "violet" }),
          // A kind T3 Code adds, or one it sends broken, is no choice at all.
          unknown: yield* chosen({ kind: "sticker", url: "https://example.com/x.png" }),
          broken: yield* chosen({ kind: "monogram", text: "TZ", color: "chartreuse" }),
        }
        yield* flush
        return { first, then: yield* chosen(null) }
      }),
    )
    expect(result.first).toEqual({
      lucide: { kind: "monogram", text: "IN", color: "violet" },
      unknown: { kind: "monogram", text: "IN", color: "indigo" },
      broken: { kind: "monogram", text: "IN", color: "indigo" },
    })
    expect(result.then).toEqual({ kind: "image", url: "/projects/Rosie/p-int/icon", revision: expect.stringMatching(/^[0-9a-f]{16}$/), text: "IN", color: "indigo" })
    // Never T3 Code's own path to it, which is a key to the image while it lasts.
    expect(JSON.stringify(result)).not.toMatch(/api\/assets|signed-token/)
  })

  test("what T3 Code sends that isn't an image is never served as one", async () => {
    const t3 = serving({ file: "v1-favicon.svg", type: "text/html" })
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
