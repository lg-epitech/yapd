# yapd

I'm tired of reading my agent outputs. So I have another agent yap instead!

When a Claude Code or Codex session finishes, yapd tells you what it did in a sentence or two. Talk back to cut it short, ask a question or tell the agent what to do next. Or press a shortcut and dictate the next job. Your eyes can stay wherever they were.

It needs a Mac with Apple silicon, [Bun](https://bun.sh) and Xcode's command line tools. The voice and the listening both run on your Mac.

With [ffmpeg](https://ffmpeg.org) installed it sounds a bit like Jarvis :)

Every setting, and how it all works, is in [the long version](docs/guide.md).

## Setup

```sh
bun add -g @launatic/yapd
yapd setup
```

That hooks yapd into Claude Code and Codex without touching your own hooks, keeps it running in the background and runs `yapd doctor` to tell you what's still missing. Codex asks you to trust the new hooks. Settings go in `~/.yapd/.env`, and `yapd install` applies them.

To update, run `bun add -g @launatic/yapd@latest` and then `yapd install`.

## Menu bar

The menu bar app, in the [latest release](https://github.com/lg-epitech/yapd/releases/latest), turns yapd off when you need quiet and replays the last few updates. Its arc reactor shows whether yapd is talking, listening or off. It isn't notarized, so macOS blocks it the first time. Choose Open Anyway in Privacy & Security.

## Interrupting

Talk while yapd is talking and it stops. "Got it" ends the update, "which PR was that?" gets an answer, and "merge it" goes to the agent as your next message. If you were talking to someone else, it picks up where it left off.

Replies reach Claude Code wherever it runs, Codex in a terminal and [T3 Code](https://github.com/pingdotgg/t3code) threads. It cancels its own echo, so speakers are fine. yapd only speaks English, but `YAPD_LANGUAGE=french` lets you answer in French.

## Starting new work

Press ctrl+option+cmd+space, ramble like you would to a colleague, and press it again. yapd works out the project, writes a proper prompt, starts the session and tells you where it went. It never guesses the project. If it can't tell, it asks.

Put your habits in `~/.yapd/preferences.md` in plain words, like "Fable on high for hard bugs, a worktree for features", and it goes by them.

## Agents on another machine

yapd talks on your Mac, but the agents can run anywhere, Linux included. Install it on the server too and forward port 4747 back to the Mac. Updates come in and your replies go back out. [Here's how](docs/guide.md#agents-on-another-machine).

## Providers

yapd doesn't bring its own model. It borrows a coding agent CLI you're already signed in to: Codex by default, or Claude Code, Grok Build, Antigravity, OpenCode, Cursor or Gemini CLI. Pick one with `YAPD_PROVIDER`.

## Style

yapd talks plainly until you give it a personality:

```sh
YAPD_STYLE="Talk like Jarvis from Iron Man: calm, precise, with a dry British wit. Call me sir."
```

## Quick turns

yapd skips turns shorter than 20 seconds, since you were watching anyway. `YAPD_MIN_SECONDS=0` makes it say every one.
