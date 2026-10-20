# yapd, the long version

Everything the [README](../README.md) skips: how each part works, and every setting.

Needs a Mac with Apple silicon, [Bun](https://bun.sh), Xcode's command line tools (`xcode-select --install`) and any of the [available providers](#providers). The agents can also run [on other machines](#agents-on-another-machine), Linux included, and yapd itself can [run on a server](#running-yapd-on-a-server), Linux too, and speak through your Mac or your phone. Most of what yapd does with your threads goes through [T3 Code](#t3-code).

The voice is [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), which runs locally, on your Mac's GPU when it can, and downloads on first start. It only speaks English, so yapd translates updates written in other languages, and has any other words that slip through translated before it says them. It also keeps to what can be said aloud: it says "the wallet address" or "its ID" rather than reading one out.

The lines quoted here are as yapd says them with no [style](#style). Give it one that calls you "sir" and they do too.

## Setup

```sh
bun add -g @launatic/yapd
yapd setup
```

This adds yapd's hooks to Claude Code and Codex, whichever you have, next to any of your own, and keeps each file as it was beside it, ending in `.before-yapd`. Codex asks you to accept its hooks on your next session. Claude Code's Stop hook runs in the background and waits while yapd reads the update, and after, until the session does something else or nine minutes have passed, so it can hand the session [your reply](#where-follow-ups-go), even to an update you [hear again](#menu-bar).

Then it runs yapd in the background with launchd, starts it at login and restarts it if it stops. Logs go to `~/Library/Logs/yapd.log`. It keeps the `PATH` of the shell you set it up from, so run `yapd install` after changing your settings or moving a CLI. `yapd uninstall` stops it. To run it in the foreground instead, uninstall it and use `yapd serve`.

Last, it runs `yapd doctor`, which checks all of that and says how to fix what's missing. Run it whenever yapd seems off.

`YAPD_HOME` moves `~/.yapd` somewhere else. Set it in your shell before `yapd setup`, since the settings file lives inside it.

Doctor also checks whether Codex trusts yapd's hooks. If they're untrusted or have changed, run `codex` and review them in `/hooks` on the machine running the agent. Trust survives logins and restarts, but changing a hook definition, including its command, requires approval again.

Your settings go in `~/.yapd/.env`, where yapd also keeps what it downloads and remembers. `YAPD_PORT` moves the port its hooks and its [API](api.md) use, 4747 by default.

On first start yapd asks for the microphone, so you can interrupt it.

To update, then restart it:

```sh
bun add -g @launatic/yapd@latest
yapd install
```

To run it from a clone instead, `bun install` and `bun link` in it, then `yapd setup`. The hooks and the service then run the clone. A `.env` or `preferences.md` in the clone moves to `~/.yapd` the first time yapd runs.

## T3 Code

yapd works with Claude Code and Codex alone, but [T3 Code](https://github.com/pingdotgg/t3code) is where it sees your threads. With it, [the shortcut](#asking-yapd) knows what each thread is doing and can message, stop and [tidy](#tidying-threads) them, [agents' questions](#when-agents-need-you) are read out, new work starts as a thread, and [reminders about threads](#reminders), [research](#finding-things-out) and usage warnings work.

It needs T3 Code 0.0.46 or later, for now the nightly, and a token from the app's own CLI, which matches its version:

```sh
ELECTRON_RUN_AS_NODE=1 "/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code (Nightly)" \
  "/Applications/T3 Code (Nightly).app/Contents/Resources/app.asar/apps/server/dist/bin.mjs" \
  auth session issue --label yapd --ttl 365d --token-only
```

Put it in `~/.yapd/.env` as `YAPD_T3CODE_TOKEN=...` and run `yapd install` again. If yapd says T3 Code turned down its token, issue a new one. `yapd doctor` says whether it takes the one you have.

## Menu bar

The menu bar app turns yapd off and on, and shows what it's doing without opening the menu. Take `yapd-menu-bar-<version>.zip` from the [latest release](https://github.com/lg-epitech/yapd/releases/latest) and move `yapd.app` into Applications. It isn't notarized, so macOS blocks it the first time you open it: choose Open Anyway in System Settings, Privacy & Security. From then on it opens at login, which System Settings, General, Login Items can stop.

From a clone, `bun run app` builds it with Xcode into `~/Applications` and opens it instead. If `xcodebuild` says it needs Xcode, point the command line tools at it with `sudo xcode-select -s /Applications/Xcode.app`.

| Icon | |
| --- | --- |
| Arc reactor | On, and quiet |
| Arc reactor with a moon | On, in focus or quiet |
| Arc reactor with a dot | On, and a thread waits on you |
| Speaker | Speaking |
| Microphone | Listening, for your reply or while you dictate |
| Arc reactor gone dark, just its casing and an empty core | [Off](#turning-yapd-off) |
| Faded arc reactor | yapd isn't running |

The menu lists the threads with the latest updates, each with its project's icon as T3 Code draws it, how long ago it finished and whether it's muted. Click one to hear its latest update again and reply to it. Hover over one for a panel beside it with what the thread is doing, its branch and pull request, and the latest it told you. There you can hear it again, [mute](#muting-threads) it for good or for an hour, have its [subagents](#subagents) read to you, and open its pull request. With the keyboard, → or Return on a thread opens its panel.

The Mode menu puts yapd in [focus](#focus-and-quiet) for an hour or quiet until the morning, or back to normal, and the menu says when focus or quiet ends. While a thread waits on you, the menu says how many do: choose it and yapd tells you who, aloud. While there's anything you haven't heard, the menu offers Catch Me Up (N), and each thread says how many of its updates you haven't heard, unless it's muted. Choose it and yapd [catches you up](#catching-up), aloud, even while it's off. Clear Catch-Up under it sets all of that aside as heard, at once and with no asking first: "scratch that" by voice within two minutes brings back what you haven't heard since.

The Reminders menu lists what you've asked yapd to [tell you later](#reminders), each with its time or its thread, even while it's off. Hover over one and choose Cancel, as "cancel the bank reminder" does, and "scratch that" by voice keeps it again. You set them by voice.

When you ask yapd to [show you](#show-me) something, the card goes up in a panel under the icon. Show Last Card brings the last one back.

The app only uses yapd's [API](api.md), so you can make your own, on Linux too.

## How updates are said

When a Claude Code or Codex session finishes, yapd sums up the reply in a headline of about fifteen words and says it, keeping the rest for when you say "more". What needs you, like a question or a failure, is said in full, question and all. If several finish together you hear them one at a time, and whatever needs you goes first.

From [T3 Code](#t3-code), yapd also hears when a thread fails or hits a usage limit, and when work finishes in a thread that has no hook. Each is said once, and a finished turn is never told by both its hook and T3 Code.

Updates that only say how running work is going, like another review round, are held for a [digest](#focus-and-quiet).

yapd says when a provider's limit passes 95 percent of a window, once a window, and keeps 80 percent for the next digest. It reads that from this Mac's T3 Code every five minutes.

Turns that finish quickly are [skipped](#quick-turns), since you were probably watching.

## Interrupting

Say anything while yapd is talking and it stops. The model that writes the summaries then works out what you meant:

- "Got it", "sounds good" or "quiet" and it stays quiet. "Stop", "skip" or "enough" skips the update. Agreeing only goes to the agent when it asked you something, and "leave it as it is" never does.
- "More" over a headline, or just after it, says the rest at once.
- "Say that again", "come again" or "pardon" plays the line again, word for word.
- Ask something the update answers, like "which PR was that?", and it answers.
- Tell the agent something, like "merge it" or "look again", and it goes to the session as your message. You hear the reply like any other update, even a quick one, unless the agent only says it understood.
- What's yapd's to do rather than the agent's goes to yapd, as if you'd [pressed the shortcut](#asking-yapd): another thread ("tell the billing one to wait for this"), "who needs me?", "show me the PR", a reminder, new work, or how yapd talks ("let me focus till three"). That takes a second model call, so it's a few seconds slower.
- "Mute it", "read me its subagents", "focus" or "talk shorter" change what yapd tells you, as [muting](#muting-threads), [subagents](#subagents) and [focus](#focus-and-quiet) explain. Nothing about them reaches the agent.
- "Settle it" or "archive the docs one" [tidies](#tidying-threads) threads, as the shortcut does.
- "Mute." on its own [turns yapd off](#turning-yapd-off).
- If you were talking to someone else, it picks up where it left off. If that keeps happening, say with a TV on, it reads the rest without stopping for anything but "Mute.".

Handed to yapd like that, new work, reminders, modes and mutes are only done when you've dictated or replied in the last ten minutes. Otherwise yapd asks you to use the shortcut, in case it was a TV. Keeping something in mind, forgetting it, or a [routine's](#memories-and-routines) name always gets you asked to use the shortcut.

You can also reply just after it finishes, so "yes, merge it" works when an update ends on a question. You have three seconds after an update, or eight after one that asks you something while you've been talking to yapd. The replies people give most are taken at once: a plain "yes" or "go ahead" to an update that asked something goes straight to the agent, and "thanks", "got it", "skip it" or "quiet" just end the update. Anything more, yapd takes about as long to work out as it does to write a summary, around two seconds with Codex. When that takes more than a third of a second, a soft tick tells you it heard you.

A failure, a usage limit or a reminder about a thread can be answered too once it has played to the end, like "tell it to fix them and run them again", but only when you've dictated or replied in the last ten minutes. Otherwise yapd only listens for "Mute." after it. After "On it" for something you asked, "scratch that" takes it back.

Pausing to think doesn't cut you off. yapd keeps listening while it works out what you meant, and if you carry on, it takes in all of it. If you trail off mid-sentence, like "and tell it to…", it waits a few seconds more. When it passes something on, it just says it's on it, without repeating what you asked.

You can send several follow-ups to the same update, including one you hear again. If the session is still on an earlier voice reply, yapd says it queued the next one. It sends queued replies in order as each turn finishes, and tells you when each goes through or fails. Typing unrelated work into the session cancels its queued replies and makes the old update stale. The queue is kept by the running daemon: turning yapd off or restarting it drops replies that haven't started delivery.

The microphone is only on while yapd has something to say and for a few seconds after, and while you [dictate](#dictating). It uses FaceTime's echo cancellation, so speakers are fine. That starts over each time the microphone comes on and needs the first three seconds yapd says to learn its voice. Talking over those stops it all the same, and the model is told your first words may be yapd's own, so if what you said may be cut off, it asks you to say it again. If only yapd's own voice stopped it, it picks up again a word or two back, and logs "Stopped for its own voice over its first seconds" in `~/Library/Logs/yapd.log`, so you can count how often that happens on your speakers. An update it ended on what may have been only its own voice is left for "what did I miss?".

[Whisper](https://huggingface.co/onnx-community/whisper-base) transcribes you on your Mac and only the words go to the provider. It downloads on first start. Whisper assumes English, so set `YAPD_LANGUAGE=french` or whichever language you speak. yapd still answers in English, but what it passes on to the agent stays in yours. `YAPD_WHISPER` picks another model, like `onnx-community/whisper-small`, which is more accurate but slower. `YAPD_LISTEN=false` never opens the microphone.

## Where follow-ups go

yapd hands a follow-up to the session the update came from, through whatever that agent offers outside tools, so it doesn't matter which terminal or editor you use:

- Claude Code, anywhere it runs: the terminal, an editor or the desktop app. The Stop hook above wakes the session with your reply. Claude sees it as a message relayed from you rather than one you typed.
- Codex 0.157 or later in the terminal, through `codex queue`. It shows up as your next message.
- [T3 Code](#t3-code) threads, through its API, so the message shows up in the thread as if you'd typed it.

A session another app drives, like T3 Code, only gets follow-ups through that app, so its own view stays in step. Queued follow-ups use the session's latest reply to find its thread. yapd won't send anything from an old update after you've started unrelated work, and says so when it can't reach a session.

## Dictating

Press ctrl+option+cmd+space from any app and talk to yapd. Once you've been quiet for about two seconds, it's sent, so you needn't press again, though you can, sooner. Escape drops it. A short rising sound says it's listening, a higher one that it's sent, a falling one that it's dropped. A shorter pause to think doesn't end it. To send only when you press again, set `YAPD_SEND_ON_PAUSE=false`; on a [server](#running-yapd-on-a-server), that's for every Mac that connects. [Your phone](#your-phone) always waits for you to press again. What you said goes to [the assistant](#asking-yapd).

If yapd is reading an update when you press it, it stops, and reads it again from the start once you're done, along with anything that came in meanwhile. If you forget about it, it stops listening after five minutes and drops what it heard. It doesn't need any permission beyond the microphone.

Whisper hears dictation with a larger model than interruptions, [whisper-small](https://huggingface.co/onnx-community/whisper-small), since a misheard prompt costs more than a misheard "merge it". It downloads when yapd first starts, about a gigabyte, and loads the first time you dictate. `YAPD_DICTATION_WHISPER` picks another, like `onnx-community/whisper-large-v3-turbo`, which is more accurate but a few times slower. `YAPD_LANGUAGE` applies here too.

Set `YAPD_SHORTCUT` to use other keys, like `YAPD_SHORTCUT=ctrl+option+cmd+d`, or `none` to turn it off. It needs ctrl, option or cmd, unless it's a function key. If another app or macOS already uses it, yapd says so in its log. Dictating needs the microphone, so there's no shortcut with `YAPD_LISTEN=false`.

## Asking yapd

The shortcut reaches one assistant that knows your [T3 Code](#t3-code) threads, on this Mac and on [other machines](#agents-on-another-machine): what each is doing, what it's called, what you started it with and what yapd last said about it. Talk to it as you would to someone who's been keeping an eye on things:

- "What's going on?", "what's the billing one doing right now?" or any plain question.
- "Who needs me?" says which threads wait on you, and for what.
- "How much Claude have I got left?" reads your usage.
- "Catch me up" [catches you up](#catching-up).
- "Show me what's running" [puts it on your screen](#show-me).
- "Tell the billing one to use the new fee table" sends that thread a message. A busy thread gets it in the turn under way, or in T3 Code's own queue when you say "when it's done" or the turn is waiting on you, and yapd says which.
- "Stop the billing one", then "carry on" if you change your mind. "Stop and do this instead" stops its turn, then tells it once it shows stopped.
- "Say that again" repeats what it just said.
- Anything that's a job is [new work](#starting-new-work).

It picks the thread you mean by how it sounds and what it's about, so a misheard name usually still lands. "It" means what you were just listening to. When it isn't sure, it asks one question, naming what it's choosing between. Answer by talking right after it, or with the shortcut: whatever you say next answers it or replaces it. Left unanswered, it's asked once more a minute later in other words, then dropped with a word. Two things in one breath, like "stop the billing one and tell the search one to rebase", are done in order, and if one doesn't go, it says what it left.

Answers come before any update waiting to be read. After one you have six seconds to follow up: "tell it to fix the tests", "stop it" or "show me that" act on the thread it was about, and "thanks" ends it.

Nothing is sent twice behind your back. The same words to a thread that hasn't answered since get "I sent that a minute ago. Again?", and a message yapd can't confirm got there, even across a restart, gets "Send it again?". Saying the same words again is a yes.

"Scratch that" or "undo that" takes back the newest thing you changed in the last two minutes: a message still in the queue, a mute, a mode, a reminder, a memory, the catch-up you cleared, or threads you tidied. "Withdraw that message" takes back the message alone, and "cancel that reminder" the reminder alone. A bare "stop" still only stops yapd talking.

Without a T3 Code token it knows no threads, but still starts new work [from the command line](#where-sessions-start). The [API](api.md#asking-yapd-something) takes a typed request the same way.

## Show me

Ask yapd to show you something, like "show me what's running", "show me that PR", "show me my usage" or "show me what I missed", and the card goes up in a panel under the [menu bar](#menu-bar) icon as yapd says it. It's there to read only, until a while after yapd has finished talking about it. "Hide that" takes it down sooner, and Show Last Card in the menu brings it back. "Open that PR" opens it in your browser, and only ever the https address T3 Code has for it.

Ask about a thread that waits on something yapd can't read aloud, like a command, and its card comes with the answer. "Show me the question" puts an agent's question up as it's asked again. Cards need the menu bar app.

## When agents need you

An agent's question in a T3 Code thread, on this Mac or another machine, is read out as it comes, in its own words, a part at a time. The option it recommends is said as yapd's pick: "I'd go with Blue." Answer with an option, a few of them where you can pick several, "yes" to the pick, or your own words, which the agent gets as you said them. "What are the options?", "what's the question?" and "later" work too. "Later" asks it again in ten minutes.

Only an option's exact name, as the agent wrote it, skips the model. The model handles the rest, like "your pick", "the second one", "four" for "4 workers" or "all of them", and what it makes of it goes as your own words unless it's an option's exact name. If you cut in before the end and the rest could change what you'd be agreeing to, it asks the question again in full. Nothing you said before you heard a question answers it.

A message you dictate to a thread waiting on a question you've heard goes as its answer. One waiting on a question you haven't heard yet gets your message in its queue, and you're told it'll go once that's dealt with.

Approvals aren't read out, so you don't hear one at every turn, but "who needs me?" lists them. To approve one by voice, say "approve" or "allow" as your whole answer, like "approve it" or "yes, approve it". A plain "yes", "sure", "OK", "go ahead" or "do it" never approves one, however harmless it looks. Nor does an approve with more to it, like "approve it unless the tests fail", which gets "It needs an 'approve', so I've left it waiting for you in T3 Code."

An agent asking for a secret gets it only in T3 Code, never by voice. A message to its thread is held back while it waits on one.

After a restart, what still waits on you is asked once each machine's T3 Code has caught up. A question whose machine drops out is put by and asked again once that machine is back. An answer you give meanwhile isn't sent, and yapd says so.

## Starting new work

You talk to yapd, not to the agent. Say what you want the way you'd say it to a colleague, false starts and all, and yapd works out which project it's for, writes the prompt and starts the session. Then it tells you where it went, like "In yapd, on Fable, in a worktree." It doesn't ask you to confirm first.

The prompt keeps what you meant and everything you asked for, tidied up, with what you left out because it was obvious filled in: "follow up on what the docs agent just finished" becomes a prompt that says what that was. It adds nothing you didn't ask for. Whisper is told the names of your projects, models and machines before it listens, and what it still mangles, like "yap D", is matched against what exists. Short words are what it gets wrong most, so "no worktree" can come out as "on a work tree": yapd reads for what you'd have said, always tells you whether it made a worktree, and says so when it couldn't tell which you wanted and went by your rules.

Where the work goes is settled by the first of these that says:

1. What you said: "in yapd", "with Fable on low", "in a worktree", "on the server".
2. Your [rules](#your-rules).
3. What the project last used.

The one thing yapd won't guess is the project. It goes by a project you named, earlier work you pointed at, like "the same in the web app", or a subject only one project has. That a request looks like your last one isn't enough. When it can't tell, it asks, and you answer by talking right after the question, as you would after an update, or with the shortcut. Say "never mind" to drop it. If you don't answer, it asks once more a minute later, then drops the request and says so. What you dictated is in the log either way, along with what yapd decided, why, and the prompt as it wrote it.

Nothing waits on this. Updates keep being read while a prompt is written, and you can dictate the next request before the last one has started.

## Finding things out

"Find out whether Apple shipped an API for third-party glucose sensors on the Watch" or "look into why the server's tunnel drops overnight" is new work too: an agent finds out and tells you. One about a project starts there, like any other. One about none of them, like something on the web, starts in T3 Code's scratch project, in a folder of its own, with the agent told to report back and change nothing on your machine. yapd then says "Looking into it, on Sol." rather than where it started, so you hear which it was. Anything about code, a build, tests, a branch or a pull request is never taken for that: with no project named, yapd asks which. When a request could go either way it asks too, like "For the glucose question, is that for yapd, or shall I just look into it?"

Its first answer, as with any work yapd starts, is read to you as the answer to what you asked, headline first, then "more": however quick or slight, whatever you muted, and even after yapd restarted in between. In focus it's said at once. In quiet it waits for the morning's rundown, and with yapd off it's kept for your catch-up.

Work outside your projects needs a [T3 Code token](#t3-code) and a T3 Code with a scratch project. Asked for on another machine, that machine's yapd has to be new enough to say it has one. Otherwise yapd asks which project it's for.

## Your rules

Put what yapd should go by in `~/.yapd/preferences.md`, in your own words. A model reads it with each request, so there's no format to follow, except for [routines](#memories-and-routines), and changes apply to the next thing you dictate:

```md
Fable on high for design work and hard bugs. Opus 5.5 on high for everyday features and fixes.

A worktree for features and fixes. None for questions and anything that only reads.

When I say "the box" I mean the server.

## Routines

- land it: Merge the PR once checks pass, then update the dev worktree and reinstall yapd.
```

Routines go under a `## Routines` heading, one a line, as `- name: steps`, up to the next heading. Saying "land it" with the shortcut then sends those steps, as you wrote them, to the thread you're on, only when you say all of its name. Unlike the rest, they're read from the whole file, can't be forgotten by voice, and are never shown to the model that writes prompts for new work. A name yapd already answers to, like "ship it", which is a yes to whatever was just asked, can't be one here either: yapd goes without it, and its log says so.

`YAPD_PREFERENCES` in your settings points to a file somewhere else. Keep it short, since every prompt waits on it being read: past 6,000 characters, the rest is left out.

## Where sessions start

With a [T3 Code token](#t3-code) in your settings, new work starts as a T3 Code thread, in the projects T3 Code knows and with its defaults.

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

## New work on other machines

Work starts on the machine the project is on. yapd asks every machine in `YAPD_REMOTES` what it can start as you press the shortcut, so that it knows by the time you've finished talking, and starts the session there over SSH, as with follow-ups.

Tell yapd what you call this Mac, since its hostname is rarely that:

```sh
YAPD_NAME=studio
```

Then "on studio" means here. Without it, this Mac answers to its hostname.

## The writer's model

Prompts are written by the model that writes summaries. To use another one, set any of `YAPD_WRITER_PROVIDER`, `YAPD_WRITER_MODEL`, `YAPD_WRITER_EFFORT` and `YAPD_WRITER_TIER`, which work like the [provider settings](#providers). With Codex and the same settings as for summaries, the two share the threads yapd keeps ready.

## Muting threads

"Mute it" over or after a noisy thread's update, or "mute the billing one" with the shortcut, keeps its progress and finished work to yourself, for good or for a while, like "for an hour". Its questions, failures, limits and the answers to what you sent it still come through, and asking what it said catches you up on it. "Unmute it", "what's muted?" and "unmute everything" work too, and "scratch that" takes a mute back. A thread's panel in the [menu](#menu-bar) does the same. Nothing about it reaches the agent.

"Mute." on its own is different: it [turns yapd off](#turning-yapd-off).

## Focus and quiet

Updates that only say how running work is going, like another review round, are held for a digest: a short catch-up once nothing has been said for a minute and three are held, or one has waited twenty minutes, at most every twenty minutes. You can reply to it or cut it off. "Give me everything" has yapd say each update in full and hold none, and "talk shorter" goes back to headlines.

"Focus" holds everything that doesn't need you for an hour, or as long as you say ("focus for two hours"), and "goodnight" until 8:00 in the morning. A thread's question, a failure, a usage limit and the answer to your own message still come through, as with a muted thread. So does the answer to something you asked yapd to [find out](#finding-things-out) in focus. In quiet it waits for the morning's rundown.

"I'm back" ends either and catches you up. One that ends on its own offers you the rundown once. Work that finished or failed while yapd was down isn't told when it starts again, though a thread's question still waiting is. Turning yapd off is still the way to hear nothing of its own accord. Both are kept through a restart, and the [API](api.md#modes) sets them too.

## Turning yapd off

Turn yapd off from the menu, or say "Mute." on its own: over anything it says or just after, its first seconds and a notice too, or with the shortcut. It turns off at once, with no model and not a word back, and the log says "Turned off: he said mute". "Mute." acts the moment it's heard on its own, so "Mute." then a pause before "the billing one" turns yapd off. Say "mute the billing one" in one breath to mute a thread.

Off, yapd says nothing of its own accord and never opens the microphone to listen for a reply. The shortcut still works: ask it something and it answers, then goes quiet again. A question it asks you then waits for your next press.

Turning it off drops what you asked that hasn't started yet, a dictation and new work it was still writing up or asking you about, and keeps what it was about to say. Updates that finish meanwhile are still summed up and kept, unheard, never said on their own. Nothing reaches an agent, and an agent's question it was reading still waits for you in T3 Code.

Turn it back on from the menu, or press the shortcut and say "unmute" or "turn on". It then offers what you missed, once: "You missed five. Want the rundown?" A yes gives you the [catch-up](#catching-up), and anything else lets it go with nothing marked heard. Then it asks what agents still wait on you for. It stays off when it restarts, until you turn it on again.

## Catching up

yapd keeps every update it sums up, and knows which you heard to the end. Ask it to catch you up, however you put it, "catch me up", "what did I miss on the web app?" or "anything from the server since lunch?", and the model decides that's what you want and what about. It tells you a thread at a time, eight threads at most, each from where its latest update leaves it, so a question since answered or a failure since fixed is left out. What still needs you, a failure or an agent's question with its options, and the answer to what you asked a thread, is read as it was kept, within its thread. The rest it sums up in about ninety words. "More" gets the threads it left out, or the detail of the ones it told you of.

What it told you counts as heard only once you've heard it to the end. Muted threads are left out unless you ask about one. Nothing it does reaches an agent.

"Clear the catch-up", "skip the catch-up" or "mark everything as heard" sets it all aside without reading it: "Cleared: fifty-three updates set aside." "Scratch that" within two minutes brings back what you haven't heard since. Agents' questions still waiting are never cleared.

## Subagents

The reviews and other work T3 Code runs for a thread as its subagents are kept to yapd unless you ask for them: summed up and kept, but never said, whatever they say, and left out of what you missed. The thread's own turns, like the one where it takes in a review, are said as ever.

"Read me its subagents" over or after one of its updates, or "read me the billing migration's subagents" with the shortcut, has them read to you from now on, each led by the thread: "For the billing migration: one release blocker is left." "Stop reading its subagents" keeps them to yapd again, and "scratch that" right after either takes it back. Nothing about it reaches the agent; "have a subagent review it" still does.

"Mute it" over one of them mutes that one only. Muting the thread mutes its subagents too. "What did its subagents say?" catches you up on what they kept.

Subagents a provider runs inside the thread's own session, like Claude's Agent tool, never reach yapd: their results come in the thread's own turn.

In the menu, Read Subagents in a T3 Code thread's panel, checked while they're read, has them read or keeps them to yapd again. A subagent's row, which Recent lists only while they're read, says which thread it's part of and has no Read Subagents, since that would stop them all. Its Mute and Mute for an Hour mute that subagent only. While its thread is muted, it says so instead, since only unmuting the thread unmutes it. The [API](api.md#hearing-a-threads-subagents) does the same by a thread's key.

## Reminders

Ask yapd to remind you of something later, however you put it: "remind me at three to call the bank", "tell me when the billing one finishes", "let me know when the docs one asks me something". It says what it kept, like "I'll remind you at 3:00 PM: call the bank.", and tells you then, naming the time, so a reminder that came due while yapd was down or off still reads right. It keeps reminders up to thirty days ahead.

When a thread you're waiting on finishes, you hear that first, then its update, as one, whatever you muted. If it fails instead, you hear that it stopped before finishing, and why.

"At five, offer to tell the search fix to ship it" asks you then, "Shall I tell the search fix: ship it?", and only your yes sends it.

"What reminders do I have?", "cancel the bank reminder" (asked which, when two could be meant) and "scratch that" right after setting or cancelling one work too. One due while yapd was off is kept for when you catch up rather than said. yapd doesn't watch pull requests.

Reminders need a [T3 Code token](#t3-code) for anything about a thread. The [menu bar app](#menu-bar) lists them too, to cancel.

## Memories and routines

Ask yapd to keep something in mind, like "remember that the server's T3 Code runs the nightly", and it says "Noted: the server's T3 Code runs the nightly.", reading back what it kept. When some of it can't be read aloud, like a link, it names it by its first words instead. It goes by it from then on as what's so, never as something to do: "what do you know about the server?" answers from it, and new work you start leans on it only where it needs to.

It keeps your words as you said them, symbols and all: everything you said after "remember that", "note that" or "keep in mind". An everyday way of asking before it, like "hey Jarvis, can you", is left out. A "thanks", "please" or "Jarvis" after it is left out only when a pause sets it off, so "the magic word is please" keeps its "please".

You can add another request after it, like "remember that the web repo uses pnpm, and tell the web one to rebase". The fact is kept and the rest done as usual, as long as you join it on with "and", "then" or "also" and the fact is all you said before that word. A comma or full stop alone never splits them, so "remember that the deploy script is safe, unless it's Friday" is never kept as less than you said. That's the only way to add another request: anything else the model takes for one beside a fact or routine you said whole is never done, and yapd tells you it left it.

If the model copied it any other way, like "C" for your "C++", or left words of yours out, like a "never", nothing is kept, and yapd tells you. With more of yours around it, like a request before "remember that", it tells you to say it on its own. Saying it again keeps it once, while "the server uses C" is kept beside "the server uses C++".

"Forget that one about the server" gives "Forgotten: the server's T3 Code runs the nightly.", and "scratch that" right after keeping or forgetting one takes it back. A bare "forget it" still only stops yapd talking.

A routine is steps sent to a thread whenever you say its name. "When I say review it, have Sol review it until it's clean" gives "Noted. Review it: have Sol review it until it's clean.", so you hear exactly what's kept. Saying it again with other steps changes it and reads the new ones back.

Say it on its own: "when I say", "whenever I say" or "if I say" and the name, then the steps, or the steps then the name. An everyday way of asking before it is fine, like "hey Jarvis, can you remember that". A "thanks" or "Jarvis" is left out of the steps only when a pause sets it off, so "when I say ping, ask Jarvis" keeps "ask Jarvis". If the steps leave out anything you said, like "if the checks are green" or a "don't", or you add another request in the same breath, nothing is kept or done, and yapd tells you to say it as one request.

The name is everything you say up to your first pause, never where the model takes it to end. So say the name, pause, then the steps. In "when I say ship, if green, merge the PR" the "if green" stays in the steps. In "when I say ship if green, merge the PR" it's part of the name, which then sends "merge the PR" with no condition when you say "ship if green". A name the model ends anywhere but that pause keeps nothing, and yapd says "Pause after its name: when I say ship, then the steps." A name is three words at most, as you'd say them, so "let's ship it" is three. A longer one gets "Keep the name short: when I say ship, then the steps."

The steps are kept as they were heard, symbols and names too, never as the model copied them, since they go to an agent as they are. When speech recognition gets a name in them wrong, like "Saul" for Sol, yapd keeps nothing and tells you, and you can type that routine in your [rules](#your-rules) instead.

Then "review it", said with the shortcut, sends those steps, word for word, to the thread you're on, or to one you name, as any message you send goes. The same steps to the same thread within ten minutes ask you first. Only the whole name sends them: "ship" never sends a routine called "ship deploy", whatever the model makes of it, and a name said in one part of a request never sends them for the next part. Said with more that changes what it asks, like "review it for typos", it's your own words that go, never the steps.

The model knows a routine by its name alone, never its steps, so only yapd puts them in. Asked what a routine does, it says it can't read the steps out. The model that writes prompts for new work never sees a routine at all. A name yapd already answers to, like "scratch that", "yes", "ship it" or "turn on", can't be one. You can also write routines in your [rules](#your-rules), and one there wins over one you said.

yapd keeps forty memories and routines at most, about four thousand characters in all, since everything you ask reads them. Past that it asks you to forget something first, rather than leave any out. They're kept through restarts, and work while yapd is off.

Nothing faint, said over yapd's own voice, or that looks like a secret is kept, and it tells you why. yapd won't keep a fact that mentions a password, PIN, passphrase, recovery phrase, login, key, token, secret, code or the like, even ones that aren't secret. A fact with the word "pass" in it is refused too, whether "my Windows pass" or "the tests pass", so say "the tests work on Node 22" rather than "pass"; a pass rate is kept. That's a best effort: it can't recognise every way a secret might be said, like a door code said without the word code, so don't ask it to remember one.

A routine is refused for what looks like a value, like a key or token given with its value, since steps to an agent use those words every day: "when I say ship, push the code" is kept. A routine that mentions a password, PIN, or a door or alarm code is refused too, value or not. So is one with a word like key, token, login, PIN or code that has a digit within three words after it, as in "use the API key abc123", even "rotate the deploy key for Node 22".

A message to an agent is held back while its thread waits on a secret, or, when it looks like one, on a question you'd type an answer to. Said over an update, keeping or forgetting something, or a routine's name, gets you asked to use the shortcut, never sent to its agent, unless it's a plain yes like "ship it" to what the agent just asked.

## Tidying threads

Ask yapd to tidy a T3 Code thread, however you put it: "archive the onboarding tickets thread" gives "Archived: the onboarding tickets.", and "unarchive it" or "scratch that" brings it back. "Rename it to onboarding fee tables", "snooze the billing one until tomorrow morning", "settle it", "pin the search fix", and "unsnooze", "unsettle" and "unpin" work too. The line always names the thread. Archiving one drops the reminders you set on it, and says so. Unarchiving it, or taking it back, brings them back.

Several at once, to archive, settle or snooze them, up to six: "archive all the finished billing threads" gives "That's four threads: the billing importer, the billing fees, the billing wallets and the billing docs. Archive them all?", with the list on your screen when the app is there. "Yes" archives all four, each once, and "yes, but not the billing fees" the other three. One that started working again before your yes, or went, is left out, and said, as is one that starts working just before it's archived.

A thread at work is never archived without your yes, since archiving it stops what it's doing: "The billing importer is still working, and archiving it stops what it's doing. Archive it anyway?" One that's busy, or waiting on you, can't be settled, and yapd says so. A title that isn't your words as heard, or a thread yapd isn't sure you meant, is asked about first.

"Scratch that" right after takes a tidy back as far as T3 Code lets it: a snooze or a settle that pinning cleared is put back, but what archiving stopped stays stopped, and unsettling marks a thread active rather than as T3 Code would have it. Tidying never deletes a thread, and needs a [T3 Code token](#t3-code).

## Running yapd on a server

yapd can run on a machine that's always on, like a Linux box at home, and talk to you through whichever of your machines you're at, or your phone. The server does all the work: the models, the voice, the listening and the threads. The others only play what it says and send it what they hear, so they can sleep, close or go off the network without taking yapd with them.

On the server:

```sh
bun add -g @launatic/yapd
yapd setup server
```

That's [setup](#setup) as on a Mac, with systemd on Linux. Its log is `journalctl --user -u yapd`. To keep it running while you're logged out, `sudo loginctl enable-linger $USER`, which setup reminds you of. Your settings, rules and the T3 Code token for the server's own T3 Code go in its `~/.yapd`, and so does `YAPD_SHORTCUT`, which every client takes.

Then on each machine that uses it, say a Mac:

```sh
bun add -g @launatic/yapd
yapd setup client me@server
```

`me@server` is how you SSH there, with a key that needs no password. The client asks the server to take it in, under the name you gave it with `YAPD_NAME` or its hostname, and keeps one SSH connection open to it, which brings the server's port to this machine's `127.0.0.1:4747`. So the hooks here and the [menu bar app](#menu-bar) reach yapd as if it ran here. On a Mac, the client also runs the audio helper, so yapd speaks and listens here and the shortcut works. Its log is `~/Library/Logs/yapd-client.log`, or `journalctl --user -u yapd-client` on Linux, where it doesn't play or listen yet.

That same connection carries the server back to this machine's SSH, whatever network it's on, so the server reaches the threads here, sends follow-ups and starts work here as it does for [agents on another machine](#agents-on-another-machine), without you listing it in `YAPD_REMOTES`. That needs the SSH server on: on a Mac, Remote Login in System Settings, General, Sharing. Setup adds the server's key to `~/.ssh/authorized_keys`, allowed only from this machine itself, which is where its connection arrives. The server runs `yapd` here by its `~/.bun/bin` or the `PATH` SSH commands get.

yapd tells the time by the server's clock, in the time zone of the first machine that joined it, unless `TZ` in its settings says otherwise, so "remind me at three" and "goodnight" mean where you are.

yapd speaks through the device you used last, the one you last pressed the shortcut or the button on, and otherwise the one that connected first. What it started saying finishes there. When nothing is connected, what comes in is summed up and kept, as when it's [off](#turning-yapd-off), for when you ask to be caught up.

On a server without a GPU it can use, the voice renders on the CPU. A line plays once it's all rendered, unless the CPU renders it a few times faster than it's spoken, as a server's many cores often do: then its first sentences play while the rest renders, as on a Mac.

### Your phone

A phone reaches the server over [Tailscale](https://tailscale.com), with no SSH. On the server:

```sh
yapd pair
```

That makes a token, has yapd listen on the server's tailnet address for whatever bears it, and prints a `yapd://pair` link and a QR code for the phone, and the address and token to type in instead. `yapd pair --new` makes another, and turns the old one away.

The iPhone app is in `ios/`, and isn't on the App Store. To put it on your phone from a clone, sign in to Xcode with your Apple ID (Settings, Accounts: a free one works), connect the phone with a cable, trust the Mac, turn on Developer Mode on the phone, then:

```sh
bun run phone
```

The first time, trust the app on the phone in Settings, General, VPN & Device Management. With a free Apple ID it stops opening after a week, until you run that again. Scan the code `yapd pair` printed with the camera, or type in what it printed, and allow the microphone.

Press its button to talk, and press it again to send what you said: a pause never sends it. Its microphone is only on from that press until it's sent or dropped, so nobody around can talk over yapd, and neither can you: to [interrupt](#interrupting) or reply, press to talk, which stops what yapd is saying, or press Stop. To talk without opening it, set the Action button to Controls, then Talk to yapd: hold it, and talk. "Talk to yapd" is in Shortcuts and Control Center too. While you talk, a Live Activity on the Lock Screen and in the Dynamic Island says what yapd is doing, with buttons to send and to drop it, and while yapd speaks, to talk and to stop it. The phone is the device yapd speaks through from your first press until a little after it goes quiet with the app in the background, when it lets go, and yapd goes back to your Mac.

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

Claude Code sessions in a terminal on the server get replies through their waiting hook, as they do on the Mac. T3 Code threads and Codex sessions there get them through `yapd relay`, so a T3 Code token for the server's own T3 Code goes in `~/.yapd/.env` on the server. [New work](#new-work-on-other-machines) starts there the same way, with the server's own settings.

While it runs, yapd also keeps one SSH connection to each server open, asks `yapd t3` there where its T3 Code listens and for that token, which it keeps in memory only, and forwards a port on the Mac's `127.0.0.1` to it. The server's threads then show up beside the Mac's, by machine. Their questions are read out, and they take messages and stops by voice the same way, each only on its own machine. Follow-ups and new work go through that connection rather than a fresh login. A server that can't be reached is tried again in the background, and said to be out of reach once you ask for something there, while the Mac's threads carry on. The server's yapd needs to be one with `yapd t3`.

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

What you say to yapd, by the shortcut or back to something it said, is worked out by the same model. To have a faster one decide what you meant, set any of `YAPD_BRAIN_MODEL`, `YAPD_BRAIN_EFFORT` and `YAPD_BRAIN_TIER`, which go to the same CLI. A model of its own keeps the effort and tier you set for summaries unless you give it its own, so with `YAPD_MODEL=gpt-6-sol`, `YAPD_EFFORT=low` and `YAPD_TIER=priority`, `YAPD_BRAIN_MODEL=gpt-6.1-sol` alone runs on low and the fast tier. With Codex it then gets a Codex of its own, with its own threads kept ready. Summaries, digests and catch-ups stay with the summaries' model.

## Style

yapd talks plainly unless you tell it otherwise. Describe how it should talk in `~/.yapd/.env` and run `yapd install` again:

```sh
YAPD_STYLE="Talk like Jarvis from Iron Man: calm, precise, with a dry British wit. Call me sir."
```

The style applies to the summaries, to its answers when you interrupt, and to what it says about new work. It doesn't change what it passes on to the agent or the prompts it writes, and summaries stay short. The few lines it says most, like the one when it passes something on, are written once in your style and kept, and rendered ahead so they play the moment they're needed.

To choose what it says once you've asked for something, when it passes a reply on, sends a message by voice or starts new work, rather than the line written in your style, list your own, separated by `|`. It says a different one from the last you heard, and from one about to be said, and renders them all ahead:

```sh
YAPD_ON_IT="Right away, sir.|Very good, sir.|Consider it done, sir.|Very well, sir."
```

A line that asks something is left out, since you'd answer it.

`YAPD_VOICE` picks another of [Kokoro's voices](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md) than `bm_fable`. With [ffmpeg](https://ffmpeg.org) installed, a light effect makes it sound a bit like Jarvis. `YAPD_EFFECT` takes an ffmpeg audio filter of your own instead, or `none`. Lines start playing once their first sentences are rendered, unless your filter needs the whole line first.

## Quick turns

yapd skips turns that finish in under 20 seconds, since you were probably watching. Set `YAPD_MIN_SECONDS` in `~/.yapd/.env` to change the cutoff, or to `0` to hear every turn. The first turn of work yapd started for you, and every turn of a headless session it started, is read however quick.
