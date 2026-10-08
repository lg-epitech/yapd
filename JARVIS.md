# Jarvis: what changed

A short list of what this branch changed and what yapd can do now. The commit log has the detail, including every fix that came out of review.

Where it is: work lands on `t3/jarvis-companion-assistant`, is reviewed by GPT-6.1 Sol until it comes back with nothing to fix, then goes into `dev`, which the installed yapd (`~/projects/yapd`) runs. The database was backed up before its first migration, to `~/.yapd/yapd.before-jarvis.sqlite`, and again before the assistant went live, to `~/.yapd/yapd.before-m1.sqlite`.

Live on `dev` now: everything below. Being built: doing things to threads by voice (message, steer, stop, carry on) and showing what you ask for on screen.

## Talk to it (the shortcut)

- The shortcut goes to one brain that knows your T3 Code threads: what each is doing, what it's called aloud, what you started it with and what yapd last said about it. Ask "what's going on?", "what's the Tezos one doing right now?", "who needs me?", "how much Claude have I got left?", "what did I miss?", "say that again", plain questions, or dictate new work as before.
- It picks the thread you mean by how it sounds and what it's about, so misheard names like "MiNAS SV2" or "my Tesla's migration" land first time. Nothing in yapd overrules its pick by matching words, which is what sank the reverted attempt.
- At most one question at a time, always naming what it's choosing between, never in the same words twice. Whatever you say next answers it or replaces it. Left unanswered, it's asked once more a minute later in other words, then let go with a word (your rule).
- "It" means what you were just listening to. Work it started in the last half hour isn't started twice.
- Answers come before any update waiting to be read.
- "Stop", "skip" or "enough" over an update skips it. "What did I miss?" leaves out what's about to be read anyway, and says how many are coming up.
- `POST /utterances` takes a typed request the same way, for scripts and other apps.

## Faster

- "Yes" or "go ahead" to an update that asked something, and "thanks" or "skip it", are handled without the model: about two seconds saved on the most common replies.
- Short lines like "On it, sir." are rendered once and kept; your usual lines are written in your `YAPD_STYLE` once and rendered at startup.
- No more ~2 s wait for a fresh Codex thread after a quiet spell (one update in five); three are kept ready.
- The speaker gets ready while an update renders: about a second saved on nearly every update.
- "Who needs me?" and usage need no model call; a status question takes one, against a minute or more in the reverted attempt.

## Under the hood

- A versioned SQLite store in `~/.yapd/yapd.sqlite`, with a journal of everything heard, said and done. It survives restarts and feeds "what did I miss".
- A live link to T3 Code's threads that reconnects and catches up on its own, and actions on threads (message, steer, stop, approve, answer, archive, rename, snooze, search, usage). The brain reads through them now; acting on threads by voice is the next milestone.
- Groundwork, not switched on yet: an SSH tunnel to rig's T3 Code (token kept in memory only), and streaming plus first-sentence playback for faster speech.
- `scripts/brain-eval.ts` replays real phrases against the live model to check it picks the right thread.
- yapd's local API turns away anything a web page sends, so no site you visit can have it start work or talk to your threads.
