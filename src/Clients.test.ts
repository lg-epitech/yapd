import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Clients from "./Clients.ts"
import * as Store from "./Store.ts"

describe("Clients", () => {
  test("machines that joined are reached through their ports here, after the ones the user set, which win", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "yapd-clients-")), "yapd.sqlite")
    expect(Clients.remotes("rig=me@rig", file)).toBe("rig=me@rig")
    await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(Store.make(file), (store) =>
          store.transaction((database) => {
            const add = database.query("insert into clients (name, user, port, key, at) values (?, ?, ?, ?, 0)")
            add.run("rosie", "laurent", 4800, "ssh-ed25519 AAAA")
            add.run("rig", "laurent", 4801, "ssh-ed25519 BBBB")
          }),
        ),
      ),
    )
    expect(Clients.remotes("rig=me@rig", file)).toBe("rig=me@rig,rosie=ssh://laurent@127.0.0.1:4800")
    expect(Clients.remotes("", file)).toBe("rig=ssh://laurent@127.0.0.1:4801,rosie=ssh://laurent@127.0.0.1:4800")
  })

  test("a new client gets the lowest port no other has and nothing listens on", () => {
    expect(Clients.free(new Set([4800, 4802]), (port) => port === 4801)).toBe(4803)
    expect(Clients.free(new Set(Array.from({ length: 200 }, (_, i) => 4800 + i)), () => false)).toBeUndefined()
  })
})
