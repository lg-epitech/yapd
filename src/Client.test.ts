import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Client from "./Client.ts"
import * as Home from "./Home.ts"

describe("Client", () => {
  test("the server it uses goes in the settings in place of the one before, or at the end, leaving the rest as they were", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "yapd-client-")), ".env")
    await Bun.write(file, "# yapd's settings\nYAPD_STYLE=\"Call me sir.\"\nexport YAPD_SERVER=old@box\nYAPD_NAME=Rosie")
    Home.set("YAPD_SERVER", "laurent@rig", file)
    expect(readFileSync(file, "utf8")).toBe("# yapd's settings\nYAPD_STYLE=\"Call me sir.\"\nYAPD_SERVER=laurent@rig\nYAPD_NAME=Rosie")
    await Bun.write(file, "YAPD_NAME=Rosie")
    Home.set("YAPD_SERVER", "laurent@rig", file)
    expect(readFileSync(file, "utf8")).toBe("YAPD_NAME=Rosie\nYAPD_SERVER=laurent@rig\n")
  })

  test("the server's key only counts as let in from here on a line that doesn't keep it to other addresses", () => {
    const key = "ssh-ed25519 AAAAC3rig"
    expect(Client.lets(`from="100.64.0.0/10,fd7a:115c:a1e0::/48" ${key} fleet-rig\n`, [key])).toBe(false)
    expect(Client.lets(`from="100.64.0.0/10" ${key} fleet-rig\nfrom="127.0.0.1,::1" ${key} yapd on rig\n`, [key])).toBe(true)
    expect(Client.lets(`${key} rig\n`, [key])).toBe(true)
    expect(Client.lets(`# ${key}\n`, [key])).toBe(false)
  })
})
