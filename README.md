# yapd

I'm tired of reading my agent outputs. So I have another agent yap instead!

When a Claude Code or Codex session finishes, yapd tells you what it did in a headline, and the rest if you say "more". Talk back to cut it short, ask a question or tell the agent what to do next. Your eyes can stay wherever they were.

Press a shortcut and you get one assistant that knows all your [T3 Code](https://github.com/pingdotgg/t3code) threads. Ask "what's going on?", "who needs me?" or "catch me up", say "show me that PR", tell a thread what to do, or ramble out the next job and it starts it.

When an agent asks you something, yapd reads the question out and you answer by voice.

When you need some peace, mute a noisy thread, say "focus" or "goodnight", or turn yapd off. Off, it keeps everything for when you ask to be caught up.

It also sets reminders, remembers what you tell it to, runs your own routines and tidies threads. The agents can run on another machine too.

It needs a Mac with Apple silicon, [Bun](https://bun.sh) and Xcode's command line tools. The voice and the listening both run on your Mac.

With [ffmpeg](https://ffmpeg.org) installed it sounds a bit like Jarvis :)

Every setting, and how it all works, is in [the long version](docs/guide.md).

## Setup

```sh
bun add -g @launatic/yapd
yapd setup
```

That hooks yapd into Claude Code and Codex without touching your own hooks, keeps it running in the background and runs `yapd doctor` to tell you what's still missing. Codex asks you to trust the new hooks. Settings go in `~/.yapd/.env`, and `yapd install` applies them.

The assistant, agents' questions, reminders about threads and tidying all go through T3 Code. yapd needs T3 Code 0.0.46 or later, for now the nightly, and [a token from it](docs/guide.md#t3-code) as `YAPD_T3CODE_TOKEN`. Without one, replies still reach Claude Code and Codex, and new work starts from the command line.

To update, run `bun add -g @launatic/yapd@latest` and then `yapd install`.

## Menu bar

The menu bar app, in the [latest release](https://github.com/lg-epitech/yapd/releases/latest), turns yapd off and on, sets focus or quiet, catches you up and lists your threads, to hear again or mute. Cards you ask for, like "show me that PR", go up under it. Its arc reactor shows whether yapd is talking, listening or off, and whether a thread waits on you. It isn't notarized, so macOS blocks it the first time. Choose Open Anyway in Privacy & Security.

## Talking back

Talk while yapd is talking and it stops. "Got it" ends the update, "which PR was that?" gets an answer, and "merge it" goes to the agent as your next message. "Mute." on its own turns yapd off, and pressing the shortcut and saying "turn on" brings it back. If you were talking to someone else, it picks up where it left off.

Replies reach Claude Code wherever it runs, Codex in a terminal and T3 Code threads. It cancels its own echo, so speakers are fine. yapd only speaks English, but `YAPD_LANGUAGE=french` lets you answer in French.

## Starting new work

Press ctrl+option+cmd+space, ramble like you would to a colleague, and press it again. yapd works out the project, writes a proper prompt, starts the session and tells you where it went. It never guesses the project. If it can't tell, it asks. "Find out whether…" starts an agent that looks into it and reports back.

Put your habits in `~/.yapd/preferences.md` in plain words, like "Fable on high for hard bugs, a worktree for features", and it goes by them.

## Agents on another machine

yapd talks on your Mac, but the agents can run anywhere, Linux included. Install it on the server too and forward port 4747 back to the Mac. Updates come in, your replies go back out, and its T3 Code threads show up beside yours. [Here's how](docs/guide.md#agents-on-another-machine).

## Providers

yapd doesn't bring its own model. It borrows a coding agent CLI you're already signed in to: Codex by default, or Claude Code, Grok Build, Antigravity, OpenCode, Cursor or Gemini CLI. Pick one with `YAPD_PROVIDER`, and a faster model for working out what you say with `YAPD_BRAIN_MODEL`. [The details](docs/guide.md#providers).

## Style

yapd talks plainly until you give it a personality:

```sh
YAPD_STYLE="Talk like Jarvis from Iron Man: calm, precise, with a dry British wit. Call me sir."
```

## Quick turns

yapd skips turns shorter than 20 seconds, since you were watching anyway. `YAPD_MIN_SECONDS=0` makes it say every one.
