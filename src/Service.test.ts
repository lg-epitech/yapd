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

  test("quotes what systemd runs, so a path with spaces or a % stays one word, as written", () => {
    const unit = Service.unit({ ...options, main: "/home/me/my yapd/src/main.ts", path: "/home/me/100%/bin:/usr/bin", command: "client" })
    expect(unit).toContain('ExecStart="/Users/me/.bun/bin/bun" "/home/me/my yapd/src/main.ts" "client"')
    expect(unit).toContain('Environment="PATH=/home/me/100%%/bin:/usr/bin"')
  })
})
