# yapd

Your coding agents, out loud.

When a Claude Code or Codex session finishes, yapd sums up the reply in a sentence or two and says it. If several finish together you hear them one at a time, and whatever needs you goes first.

Needs macOS, [Bun](https://bun.sh) and a signed-in [Codex CLI](https://github.com/openai/codex).

## Setup

```sh
bun install
bun start
```

Then add the hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "bun /path/to/yapd/src/main.ts hook claude" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "bun /path/to/yapd/src/main.ts hook claude" }] }]
  }
}
```

For Codex, put the same thing in `~/.codex/hooks.json` with `hook codex`.
