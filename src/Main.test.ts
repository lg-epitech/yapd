import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test.each([["serve", "v2"], ["v2", "v2"], ["v1", "v1"]])("%s starts the %s daemon", async (command, expected) => {
  const home = await mkdtemp(join(tmpdir(), "yapd-daemon-command-"))
  try {
    await Bun.write(join(home, ".env"), "")
    await Bun.write(join(home, "preferences.md"), "")
    const main = join(import.meta.dir, "main.ts")
    const probe = join(home, "probe.ts")
    await Bun.write(probe, `
Bun.plugin({ name: "daemon-command-probe", setup(build) {
  build.onLoad({ filter: /[/\\\\](?:v2[/\\\\])?Serve\\.ts$/ }, ({ path }) => ({
    contents: 'import { Effect } from "effect"; export const serve = Effect.sync(() => console.log(' + JSON.stringify(path.includes('/v2/') ? 'v2' : 'v1') + '));', loader: "ts"
  }));
} });
process.argv = [process.execPath, ${JSON.stringify(main)}, ${JSON.stringify(command)}];
await import(${JSON.stringify(main)});
`)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("YAPD_")))
    const child = Bun.spawn([process.execPath, probe], { cwd: home, env: { ...env, YAPD_HOME: home }, stdout: "pipe", stderr: "pipe" })
    const output = await new Response(child.stdout).text(), error = await new Response(child.stderr).text()
    expect(await child.exited, error).toBe(0)
    expect(output.trim()).toBe(expected)
  } finally { await rm(home, { recursive: true, force: true }) }
})
