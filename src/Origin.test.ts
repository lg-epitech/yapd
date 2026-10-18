import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import * as Origin from "./Origin.ts"

describe("Origin", () => {
  test("a client's hook names its machine as its server knows it, from the settings file it never loads", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "yapd-origin-")), ".env")
    await Bun.write(file, '# yapd\nYAPD_STYLE="Call me sir."\nexport YAPD_SERVER=laurent@rig\nYAPD_NAME="Rosie" \n')
    expect(Origin.host({}, file)).toBe("rosie")
    // Not a client: its hostname, as before.
    await Bun.write(file, "YAPD_NAME=Rosie\n")
    expect(Origin.host({}, file)).toBe(hostname())
    expect(Origin.host({}, join(file, "missing"))).toBe(hostname())
  })
})
