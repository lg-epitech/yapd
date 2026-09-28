# yapd

I'm tired of reading my agent outputs. So I have another agent yap instead!

When a Claude Code or Codex session finishes, yapd sums up the reply in a sentence or two and says it. If several finish together you hear them one at a time, and whatever needs you goes first.

Needs macOS, [Bun](https://bun.sh) and any of the [available providers](#providers).

The voice is [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), which runs locally and downloads on first start.

With [ffmpeg](https://ffmpeg.org) installed it sounds a bit like Jarvis.

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

For Codex, put the same thing in `~/.codex/hooks.json` with `hook codex`. You will be prompted to accept both hooks on your next session.

## Providers

The summaries are written by a coding agent CLI you're already signed in to. The default is Codex with GPT-6 Luna on high. To use a different one, put this in a `.env` file in the yapd folder, which `bun start` picks up:

```sh
YAPD_PROVIDER=claude
YAPD_MODEL=sonnet
YAPD_EFFORT=low
```

Leave out the model or the effort to get that CLI's default. Both are passed through as is, so use the names that CLI expects. Codex only defaults to Luna on high when no model is set.

| `YAPD_PROVIDER` | CLI | Effort |
| --- | --- | --- |
| `codex` | [Codex](https://github.com/openai/codex) | `model_reasoning_effort` |
| `claude` | [Claude Code](https://code.claude.com) | `--effort` |
| `grok` | [Grok Build](https://docs.x.ai/build/cli/reference) | `--effort` |
| `antigravity` | [Antigravity](https://antigravity.google/docs/cli/headless/) | `--effort` |
| `opencode` | [OpenCode](https://opencode.ai), models as `provider/model` | `--variant` |
| `cursor` | [Cursor](https://cursor.com/cli) | in the model name |
| `gemini` | [Gemini CLI](https://github.com/google-gemini/gemini-cli) | a model alias from its settings |
