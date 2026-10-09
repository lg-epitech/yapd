# yapd

I'm tired of reading my agent outputs. So I have another agent yap instead!

When a Claude Code or Codex session finishes, yapd sums up the reply in a sentence or two and says it. If several finish together you hear them one at a time, and whatever needs you goes first. Talk over it to [cut it short, ask about it, or tell the agent what to do next](#interrupting), or press a shortcut and [tell yapd what to start next](#starting-new-work).

Needs a Mac with Apple silicon, [Bun](https://bun.sh), Xcode's command line tools (`xcode-select --install`) and any of the [available providers](#providers). The agents can also run [on other machines](#agents-on-another-machine), Linux included.

The voice is [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), which runs locally, on your Mac's GPU when it can, and downloads on first start. It only speaks English, so yapd translates updates written in other languages, and has any other words that slip through translated before it says them. It also keeps to what can be said aloud: it says "the wallet address" or "its ID" rather than reading one out.

With [ffmpeg](https://ffmpeg.org) installed it sounds a bit like Jarvis.

## Setup

```sh
bun add -g @launatic/yapd
yapd setup
```

This adds yapd's hooks to Claude Code and Codex, whichever you have, next to any of your own, and keeps each file as it was beside it, ending in `.before-yapd`. Codex asks you to accept its hooks on your next session. Claude Code's Stop hook runs in the background and waits while yapd reads the update, and after, until the session does something else or nine minutes have passed, so it can hand the session [your reply](#where-follow-ups-go), even to an update you [hear again](#menu-bar).

Then it runs yapd in the background with launchd, starts it at login and restarts it if it stops. Logs go to `~/Library/Logs/yapd.log`. It keeps the `PATH` of the shell you set it up from, so run `yapd install` after changing your settings or moving a CLI. `yapd uninstall` stops it. To run it in the foreground instead, uninstall it and use `yapd serve`.

Last, it runs `yapd doctor`, which checks all of that and says how to fix what's missing. Run it whenever yapd seems off.

Doctor also checks whether Codex trusts yapd's hooks. If they're untrusted or have changed, run `codex` and review them in `/hooks` on the machine running the agent. Trust survives logins and restarts, but changing a hook definition, including its command, requires approval again.

Your settings go in `~/.yapd/.env`, where yapd also keeps what it downloads and remembers.

On first start yapd asks for the microphone, so you can interrupt it.

To update, then restart it:

```sh
bun add -g @launatic/yapd@latest
yapd install
```

To run it from a clone instead, `bun install` and `bun link` in it, then `yapd setup`. The hooks and the service then run the clone. A `.env` or `preferences.md` in the clone moves to `~/.yapd` the first time yapd runs.

## Menu bar

The menu bar app turns yapd off and on, and shows what it's doing without opening the menu. Take `yapd-menu-bar-<version>.zip` from the [latest release](https://github.com/lg-epitech/yapd/releases/latest) and move `yapd.app` into Applications. It isn't notarized, so macOS blocks it the first time you open it: choose Open Anyway in System Settings, Privacy & Security. From then on it opens at login, which System Settings, General, Login Items can stop.

From a clone, `bun run app` builds it with Xcode into `~/Applications` and opens it instead. If `xcodebuild` says it needs Xcode, point the command line tools at it with `sudo xcode-select -s /Applications/Xcode.app`.

| Icon | |
| --- | --- |
| Arc reactor | On, and quiet |
| Speaker | Speaking |
| Microphone | Listening, for your reply or while you dictate |
| Arc reactor gone dark, just its casing and an empty core | Off |
| Faded arc reactor | yapd isn't running |

Off, yapd says nothing, never opens the microphone and lets go of the shortcut. Turning it off drops whatever hasn't started yet: what it was about to say, a dictation, and new work it was still writing up or asking you about. Updates that finish meanwhile aren't said later, and it stays off when it restarts, until you turn it on again. The menu also has the last few updates, to hear one again and reply to it.

Ask yapd to show you something, like "show me what's running" or "show me that PR", and the card goes up in a panel under the icon, to read only, until a while after yapd has finished talking about it. "Hide that" takes it down sooner, and Show Last Card in the menu brings it back.

The app only uses yapd's [API](docs/api.md), so you can make your own, on Linux too.

## Interrupting

Say anything while yapd is talking and it stops. The model that writes the summaries then works out what you meant:

- "Got it", "sounds good" or "mute it" and it stays quiet. Agreeing only goes to the agent when it asked you something, and "leave it as it is" never does.
- Ask something the update answers, like "which PR was that?", and it answers.
- Tell the agent something, like "merge it" or "look again", and it goes to the session as your message. You hear the reply like any other update, even a quick one, unless the agent only says it understood.
- If you were talking to someone else, it picks up where it left off. If that keeps happening, say with a TV on, it reads the rest without stopping.

You can also reply just after it finishes, so "yes, merge it" works when an update ends on a question. The replies people give most are taken at once: a plain "yes" or "go ahead" to an update that asked something goes straight to the agent, and "thanks", "got it", "skip it" or "quiet" just end the update. Anything more, yapd takes about as long to work out as it does to write a summary, around two seconds with Codex.

Pausing to think doesn't cut you off. yapd keeps listening while it works out what you meant, and if you carry on, it takes in all of it. If you trail off mid-sentence, like "and tell it to…", it waits a few seconds more. When it passes something on, it just says it's on it, without repeating what you asked. With `YAPD_STYLE` set, the few lines it says most, like that one, are written once in your style and kept, and they're rendered ahead so they play the moment they're needed.

You can send several follow-ups to the same update, including one you hear again. If the session is still on an earlier voice reply, yapd says it queued the next one. It sends queued replies in order as each turn finishes, and tells you when each goes through or fails. Typing unrelated work into the session cancels its queued replies and makes the old update stale. The queue is kept by the running daemon: turning yapd off or restarting it drops replies that haven't started delivery.

The microphone is only on while yapd has something to say and for a few seconds after, and while you [dictate](#dictating). It uses FaceTime's echo cancellation, so speakers are fine. That starts over each time the microphone comes on and needs the first three seconds yapd says to learn its voice. Over those, "stop", "wait" or "skip" work at once, and other words work when they're clearly yours; otherwise say it again once it's a few seconds in. [Whisper](https://huggingface.co/onnx-community/whisper-base) transcribes you on your Mac and only the words go to the provider. It downloads on first start.

Whisper assumes English, so set `YAPD_LANGUAGE=french` or whichever language you speak. yapd still answers in English, but what it passes on to the agent stays in yours. `YAPD_WHISPER` picks another model, like `onnx-community/whisper-small`, which is more accurate but slower. `YAPD_LISTEN=false` never opens the microphone.

### Where follow-ups go

yapd hands a follow-up to the session the update came from, through whatever that agent offers outside tools, so it doesn't matter which terminal or editor you use:

- Claude Code, anywhere it runs: the terminal, an editor or the desktop app. The Stop hook above wakes the session with your reply. Claude sees it as a message relayed from you rather than one you typed.
- Codex 0.157 or later in the terminal, through `codex queue`. It shows up as your next message.
- [T3 Code](https://github.com/pingdotgg/t3code) 0.0.46 or later, for now the nightly, through its API, so the message shows up in the thread as if you'd typed it. This needs a token from the app's own CLI, which matches its version:

  ```sh
  ELECTRON_RUN_AS_NODE=1 "/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code (Nightly)" \
    "/Applications/T3 Code (Nightly).app/Contents/Resources/app.asar/apps/server/dist/bin.mjs" \
    auth session issue --label yapd --ttl 365d --token-only
  ```

  Put it in `~/.yapd/.env` as `YAPD_T3CODE_TOKEN=...` and run `yapd install` again. If yapd says T3 Code turned down its token, issue a new one. `yapd doctor` says whether it takes the one you have.

A session another app drives, like T3 Code, only gets follow-ups through that app, so its own view stays in step. Queued follow-ups use the session's latest reply to find its thread. yapd won't send anything from an old update after you've started unrelated work, and says so when it can't reach a session.

## Dictating

Press ctrl+option+cmd+space from any app and talk to yapd, then press it again to send, or Escape to drop it. A short rising sound says it's listening, a higher one that it's sent, a falling one that it's dropped. Take your time: pausing to think doesn't end it, only the shortcut does. What you said becomes [new work](#starting-new-work).

If yapd is reading an update when you press it, it stops, and reads it again from the start once you're done, along with anything that came in meanwhile. If you forget about it, it stops listening after five minutes and drops what it heard. It doesn't need any permission beyond the microphone.

Whisper hears dictation with a larger model than interruptions, [whisper-small](https://huggingface.co/onnx-community/whisper-small), since a misheard prompt costs more than a misheard "merge it". It downloads when yapd first starts, about a gigabyte, and loads the first time you dictate. `YAPD_DICTATION_WHISPER` picks another, like `onnx-community/whisper-large-v3-turbo`, which is more accurate but a few times slower. `YAPD_LANGUAGE` applies here too.

Set `YAPD_SHORTCUT` to use other keys, like `YAPD_SHORTCUT=ctrl+option+cmd+d`, or `none` to turn it off. It needs ctrl, option or cmd, unless it's a function key. If another app or macOS already uses it, yapd says so in its log. Dictating needs the microphone, so there's no shortcut with `YAPD_LISTEN=false`.

## Starting new work

You talk to yapd, not to the agent. Say what you want the way you'd say it to a colleague, false starts and all, and yapd works out which project it's for, writes the prompt and starts the session. Then it tells you what it did, like "Started in yapd, on Fable, in a worktree." It doesn't ask you to confirm first.

The prompt keeps what you meant and everything you asked for, tidied up, with what you left out because it was obvious filled in: "follow up on what the std agent just finished" becomes a prompt that says what that was. It adds nothing you didn't ask for. Whisper is told the names of your projects, models and machines before it listens, and what it still mangles, like "yap D", is matched against what exists. Short words are what it gets wrong most, so "no worktree" can come out as "on a work tree": yapd reads for what you'd have said, always tells you whether it made a worktree, and says so when it couldn't tell which you wanted and went by your rules.

Where the work goes is settled by the first of these that says:

1. What you said: "in yapd", "with Fable on low", "in a worktree", "on rig".
2. Your [rules](#your-rules).
3. What the project last used.

The one thing yapd won't guess is the project. It goes by a project you named, earlier work you pointed at, like "the same in std", or a subject only one project has. That a request looks like your last one isn't enough. When it can't tell, it asks, and you answer by talking right after the question, as you would after an update. Say "never mind" to drop it. If you don't answer, it asks once more a minute later, then drops the request and says so. What you dictated is in the log either way, along with what yapd decided, why, and the prompt as it wrote it.

Most prompts are written from what you said, in a few seconds. When a request leans on something in the project, like "do for the responder what we did for the condenser", yapd reads the project first, which takes longer, and says so before it starts: "Looking through yapd first." It reads with the provider's CLI kept from changing anything: Codex in its read-only sandbox, Claude Code with only its tools that read. With other providers it doesn't read projects, and writes from what you said.

Nothing waits on this. Updates keep being read while a prompt is written, and you can dictate the next request before the last one has started. The shortcut only ever starts a new request, so answer questions by talking.

### Your rules

Put what yapd should go by in `~/.yapd/preferences.md`, in your own words. A model reads it with each request, so there's no format to follow, and changes apply to the next thing you dictate:

```md
Fable on high for design work and hard bugs. Opus 5.5 on high for everyday features and fixes.

A worktree for features and fixes. None for questions and anything that only reads.

When I say "the rig" I mean rig.
```

`YAPD_PREFERENCES` in your settings points to a file somewhere else. Keep it short, since every prompt waits on it being read: past 6,000 characters, the rest is left out.

### Where sessions start

With a [T3 Code token](#where-follow-ups-go) in your settings, new work starts as a T3 Code thread, in the projects T3 Code knows and with its defaults.

Without one, yapd starts Claude Code or Codex from the command line, headless. It finds your projects in the folders you list, and in any repository an agent has run in since the hooks were set up:

```sh
YAPD_PROJECTS=~/projects,~/work
YAPD_WORKTREE=true
```

`YAPD_WORKTREE` is whether work gets a worktree when nothing else says. Worktrees go in `~/.yapd/worktrees`, and what each session printed in `~/.yapd/sessions`.

Approvals stay on for the sessions yapd starts. Nobody is there to answer them, so whatever would have asked is refused, and yapd tells you what the session tried to do and how to pick it up in a terminal. Those sessions are always read out, however short their turn, since you weren't watching. To let them do more, say so:

```sh
YAPD_CLAUDE_PERMISSIONS=acceptEdits
YAPD_CODEX_SANDBOX=workspace-write
```

The first is Claude Code's `--permission-mode` and the second Codex's sandbox. Left unset, each runs as you've set it up yourself. For Codex that means it can read but not change anything, unless your own Codex config says otherwise, and yapd tells you so when it starts one that way.

You reply to a headless session like to any other. It has no terminal to type into, so yapd picks the session up again for one more turn.

### On other machines

Work starts on the machine the project is on. yapd asks every machine in `YAPD_REMOTES` what it can start as you press the shortcut, so that it knows by the time you've finished talking, and starts the session there over SSH, as with follow-ups. Reading a project happens on its machine too, with the provider set in that machine's settings.

Tell yapd what you call this Mac, since its hostname is rarely that:

```sh
YAPD_NAME=rosie
```

Then "on rosie" means here. Without it, this Mac answers to its hostname.

### The writer's model

Prompts are written by the model that writes summaries. To use another one, set any of `YAPD_WRITER_PROVIDER`, `YAPD_WRITER_MODEL`, `YAPD_WRITER_EFFORT` and `YAPD_WRITER_TIER`, which work like the [provider settings](#providers). With Codex and the same settings as for summaries, the two share the threads yapd keeps ready.

## Agents on another machine

yapd speaks on one Mac, but the agents can run anywhere, like on a Linux server you SSH into. Set yapd up there too. Only the hooks go in, since that machine never speaks:

```sh
bun add -g @launatic/yapd
yapd setup
```

The hooks send to `127.0.0.1:4747`, so forward that port to the Mac, however you like. From the Mac, a reverse tunnel does it:

```sh
ssh -N -R 127.0.0.1:4747:127.0.0.1:4747 me@server
```

Updates then come through, named after each session's repository. For follow-ups, the Mac reaches back over SSH and runs `yapd relay` on the server, which sends them there. List the server in the Mac's settings, by the hostname it reports and how to SSH into it, then run `yapd install` again:

```sh
YAPD_REMOTES=server=me@server.example.com
```

A bare `YAPD_REMOTES=server` uses `ssh server`, so an alias from `~/.ssh/config` works. Separate several with commas. yapd SSHes in with `BatchMode`, so it needs a key that works without a password prompt, and `yapd` has to be on the `PATH` that non-interactive SSH commands get: `ssh server yapd` should print yapd's usage, not "command not found". Adding `~/.bun/bin` to `PATH` in `~/.zshenv`, or at the top of `~/.bashrc`, is usually enough. `yapd doctor` on the Mac tries each server this way.

Claude Code sessions in a terminal on the server get replies through their waiting hook, as they do on the Mac. T3 Code threads and Codex sessions there get them through `yapd relay`, so a T3 Code token for the server's own T3 Code goes in `~/.yapd/.env` on the server. [New work](#on-other-machines) starts there the same way, with the server's own settings.

While it runs, yapd also keeps one SSH connection to each server open, asks `yapd t3` there where its T3 Code listens and for that token, which it keeps in memory only, and forwards a port on the Mac's `127.0.0.1` to it. The server's threads then show up beside the Mac's, by machine, and take messages and stops by voice the same way, and follow-ups and new work go through that connection rather than a fresh login. A server that can't be reached is tried again in the background, and said to be out of reach once you ask for something there. The server's yapd needs to be one with `yapd t3`.

## Providers

The summaries are written by a coding agent CLI you're already signed in to. The default is Codex with GPT-6 Luna on high, on its fast tier, which for Luna costs no extra usage. yapd keeps Codex running between calls, with a thread ready for the next one and without your MCP servers, apps or plugins, which saves a few seconds each time. To use a different one, put this in `~/.yapd/.env` and run `yapd install` again:

```sh
YAPD_PROVIDER=claude
YAPD_MODEL=sonnet
YAPD_EFFORT=low
```

Leave out the model or the effort to get that CLI's default. Both are passed through as is, so use the names that CLI expects. Codex only defaults to Luna on high and the fast tier when no model is set. For Codex, `YAPD_TIER=priority` picks the fast tier for another model, like `YAPD_MODEL=gpt-6-sol` with `YAPD_EFFORT=low`.

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

yapd talks plainly unless you tell it otherwise. Describe how it should talk in `~/.yapd/.env` and run `yapd install` again:

```sh
YAPD_STYLE="Talk like Jarvis from Iron Man: calm, precise, with a dry British wit. Call me sir."
```

The style applies to the summaries, to its answers when you interrupt, and to what it says about new work. It doesn't change what it passes on to the agent or the prompts it writes, and summaries stay a sentence or two.

To choose what it says once you've asked for something, when it passes a reply on, sends a message by voice or starts new work, rather than the line written in your style, list your own, separated by `|`. It says a different one from the last you heard, and from one about to be said, and renders them all ahead:

```sh
YAPD_ON_IT="Right away, sir.|Very good, sir.|Consider it done, sir.|Very well, sir."
```

A line that asks something is left out, since you'd answer it.

## Quick turns

yapd skips turns that finish in under 20 seconds, since you were probably watching. Set `YAPD_MIN_SECONDS` in `~/.yapd/.env` to change the cutoff, or to `0` to hear every turn.
