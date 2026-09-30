import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/**
 * Where yapd keeps what it remembers, and the worktrees it makes. YAPD_HOME
 * moves it. Absolute, since most commands run from inside it.
 */
export const home = resolve(process.env.YAPD_HOME ?? join(homedir(), ".yapd"))

/** The user's settings. Bun reads them from the folder yapd runs in, which is `home`. */
export const settings = join(home, ".env")

/** The speech models yapd downloads, apart from the package, so an update doesn't download them again. */
export const models = join(home, "models")

/** A path as the user would write it, with `~` for their home directory. */
export const expand = (path: string) => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path)

/** A move that also works to another disk, where renaming can't. */
const move = (from: string, to: string) => {
  try {
    renameSync(from, to)
  } catch {
    copyFileSync(from, to)
    rmSync(from)
  }
}

/**
 * Makes `home`, and moves in the settings and rules that used to live in the
 * folder yapd was cloned into, once. Moved rather than copied, so there's one
 * of each to edit. Anything left behind is `yapd doctor`'s to point out.
 */
export const adopt = (folder: string, into = home) => {
  mkdirSync(into, { recursive: true, mode: 0o700 })
  for (const name of [".env", "preferences.md"]) {
    const from = join(folder, name)
    const to = join(into, name)
    if (!existsSync(from) || existsSync(to)) continue
    move(from, to)
    console.error(`Moved ${from} to ${to}, where yapd reads it from now on`)
  }
}
