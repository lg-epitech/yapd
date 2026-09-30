import { describe, expect, test } from "bun:test"
import * as Service from "./Service.ts"

const options: Service.Options = {
  bun: "/Users/me/.bun/bin/bun",
  main: "/Users/me/R&D <yapd>/src/main.ts",
  workingDirectory: "/Users/me/R&D <yapd>",
  path: "/opt/homebrew/bin:/usr/bin",
  log: "/Users/me/Library/Logs/yapd.log",
}

describe("Service", () => {
  test("escapes paths in the plist", () => {
    const plist = Service.plist(options)
    expect(plist).toContain("<string>/Users/me/R&amp;D &lt;yapd&gt;/src/main.ts</string>")
    expect(plist).not.toContain("R&D")
  })

  test("runs serve with the installing shell's PATH", () => {
    const plist = Service.plist(options)
    expect(plist).toContain("<string>serve</string>")
    expect(plist).toContain("<key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>")
    expect(plist).not.toContain("YAPD_HOME")
  })

  test("keeps yapd's home where YAPD_HOME moved it", () => {
    expect(Service.plist({ ...options, home: "/Volumes/Data/yapd" })).toContain("<key>YAPD_HOME</key><string>/Volumes/Data/yapd</string>")
  })
})
