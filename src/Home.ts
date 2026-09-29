import { homedir } from "node:os"
import { join } from "node:path"

/** Where yapd keeps what it remembers, and the worktrees it makes. YAPD_HOME moves it. */
export const home = process.env.YAPD_HOME ?? join(homedir(), ".yapd")

/** A path as the user would write it, with `~` for their home directory. */
export const expand = (path: string) => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path)
