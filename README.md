# yapd

I'm tired of reading my agent outputs. So I have another agent yap instead!

When a Claude Code or Codex session finishes, yapd sums up the reply in a sentence or two and says it. If several finish together you hear them one at a time, and whatever needs you goes first. Talk over it to [cut it short, ask about it, or tell the agent what to do next](#interrupting).

Needs macOS, [Bun](https://bun.sh), Xcode's command line tools (`xcode-select --install`) and any of the [available providers](#providers). The agents can also run [on other machines](#agents-on-another-machine), Linux included.

The voice is [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), which runs locally and downloads on first start.

With [ffmpeg](https://ffmpeg.org) installed it sounds a bit like Jarvis.

## Setup

```sh
bun install
bun src/main.ts install
```

This runs yapd in the background with launchd, starts it at login and restarts it if it stops. Logs go to `~/Library/Logs/yapd.log`. It keeps the `PATH` of the shell you install from, so run it again after changing `.env` or moving a CLI. `bun src/main.ts uninstall` removes it. To run it in the foreground instead, uninstall it and use `bun start`.

Then add the hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun /path/to/yapd/src/main.ts hook claude --wait",
            "async": true,
            "asyncRewake": true
          }
        ]
      }
    ],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "bun /path/to/yapd/src/main.ts hook claude" }] }]
  }
}
```

The Stop hook runs in the background and waits while yapd reads the update, so it can hand the session [your reply](#where-follow-ups-go).

For Codex, put both hooks in `~/.codex/hooks.json` as plain commands with `hook codex`, without `--wait` or the two async settings. You will be prompted to accept the hooks on your next session.

On first start yapd asks for the microphone, so you can interrupt it.

## Interrupting

Say anything while yapd is talking and it stops. The model that writes the summaries then works out what you meant:

- "Got it", "sounds good" or "mute it" and it stays quiet. Agreeing only goes to the agent when it asked you something, and "leave it as it is" never does.
- Ask something the update answers, like "which PR was that?", and it answers.
- Tell the agent something, like "merge it" or "look again", and it goes to the session as your message. You hear the reply like any other update, even a quick one, unless the agent only says it understood.
- If you were talking to someone else, it picks up where it left off. If that keeps happening, say with a TV on, it reads the rest without stopping.

You can also reply just after it finishes, so "yes, merge it" works when an update ends on a question. yapd takes about as long to respond as it does to write a summary, around five seconds with Codex.

Pausing to think doesn't cut you off. yapd keeps listening while it works out what you meant, and if you carry on, it takes in all of it. If you trail off mid-sentence, like "and tell it to…", it waits a few seconds more. When it passes something on, it says back each step it sent, so you'd hear if one went missing.

The microphone is only on while yapd has something to say and for a few seconds after. It uses FaceTime's echo cancellation, so speakers are fine. [Whisper](https://huggingface.co/onnx-community/whisper-base) transcribes you on your Mac and only the words go to the provider. It downloads on first start.

Whisper assumes English, so set `YAPD_LANGUAGE=french` or whichever language you speak. `YAPD_WHISPER` picks another model, like `onnx-community/whisper-small`, which is more accurate but slower. `YAPD_LISTEN=false` never opens the microphone.

### Where follow-ups go

yapd hands a follow-up to the session the update came from, through whatever that agent offers outside tools, so it doesn't matter which terminal or editor you use:

- Claude Code, anywhere it runs: the terminal, an editor or the desktop app. The Stop hook above wakes the session with your reply. Claude sees it as a message relayed from you rather than one you typed.
- Codex 0.157 or later in the terminal, through `codex queue`. It shows up as your next message.
- [T3 Code](https://github.com/pingdotgg/t3code) threads, through its API, so the message shows up in the thread as if you'd typed it. This needs a token from the app's own CLI, which matches its version:

  ```sh
  ELECTRON_RUN_AS_NODE=1 "/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)" \
    "/Applications/T3 Code (Alpha).app/Contents/Resources/app.asar/apps/server/dist/bin.mjs" \
    auth session issue --label yapd --ttl 365d --token-only
  ```

  Put it in `.env` as `YAPD_T3CODE_TOKEN=...` and run `bun src/main.ts install` again. If yapd says T3 Code turned down its token, issue a new one.

A session another app drives, like T3 Code, only gets follow-ups through that app, so its own view stays in step. yapd won't send anything to a session that has moved on since the update, like when you've already typed something else, and says so when it can't reach one.

## Agents on another machine

yapd speaks on one Mac, but the agents can run anywhere, like on a Linux server you SSH into. Install yapd there too, without `install`, since that machine only runs the hooks:

```sh
bun install
bun link
```

Add the hooks there as above. They send to `127.0.0.1:4747`, so forward that port to the Mac, however you like. From the Mac, a reverse tunnel does it:

```sh
ssh -N -R 127.0.0.1:4747:127.0.0.1:4747 me@server
```

Updates then come through, named after each session's repository. For follow-ups, the Mac reaches back over SSH and runs `yapd relay` on the server, which sends them there. List the server in the Mac's `.env`, by the hostname it reports and how to SSH into it, then run `bun src/main.ts install` again:

```sh
YAPD_REMOTES=server=me@server.example.com
```

A bare `YAPD_REMOTES=server` uses `ssh server`, so an alias from `~/.ssh/config` works. Separate several with commas. yapd SSHes in with `BatchMode`, so it needs a key that works without a password prompt, and `yapd` has to be on the `PATH` that non-interactive SSH commands get: `ssh server yapd` should print yapd's usage, not "command not found". Adding `~/.bun/bin` to `PATH` in `~/.zshenv`, or at the top of `~/.bashrc`, is usually enough.

Claude Code sessions in a terminal on the server get replies through their waiting hook, as they do on the Mac. T3 Code threads and Codex sessions there get them through `yapd relay`, so a T3 Code token for the server's own T3 Code goes in the `.env` of yapd's folder on the server.

## Providers

The summaries are written by a coding agent CLI you're already signed in to. The default is Codex with GPT-6 Luna on high, on its fast tier, which for Luna costs no extra usage. yapd keeps Codex running between calls, which saves a few seconds each time. To use a different one, put this in a `.env` file in the yapd folder and run `bun src/main.ts install` again:

```sh
YAPD_PROVIDER=claude
YAPD_MODEL=sonnet
YAPD_EFFORT=low
```

Leave out the model or the effort to get that CLI's default. Both are passed through as is, so use the names that CLI expects. Codex only defaults to Luna on high and the fast tier when no model is set.

| `YAPD_PROVIDER` | CLI | Effort |
| --- | --- | --- |
| `codex` | [Codex](https://github.com/openai/codex) | `model_reasoning_effort` |
| `claude` | [Claude Code](https://code.claude.com) | `--effort` |
| `grok` | [Grok Build](https://docs.x.ai/build/cli/reference) | `--effort` |
| `antigravity` | [Antigravity](https://antigravity.google/docs/cli/headless/) | `--effort` |
| `opencode` | [OpenCode](https://opencode.ai), models as `provider/model` | `--variant` |
| `cursor` | [Cursor](https://cursor.com/cli) | in the model name |
| `gemini` | [Gemini CLI](https://github.com/google-gemini/gemini-cli) | a model alias from its settings |

## Style

yapd talks plainly unless you tell it otherwise. Describe how it should talk in `.env` and run `bun src/main.ts install` again:

```sh
YAPD_STYLE="Talk like Jarvis from Iron Man: calm, precise, with a dry British wit. Call me sir."
```

The style applies to the summaries and to its answers when you interrupt. It doesn't change what it passes on to the agent, and summaries stay a sentence or two.

## Quick turns

yapd skips turns that finish in under 20 seconds, since you were probably watching. Set `YAPD_MIN_SECONDS` in `.env` to change the cutoff, or to `0` to hear every turn.
