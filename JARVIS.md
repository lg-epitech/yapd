# Jarvis: what changed

A short list of what this branch changed and what yapd can do now. The commit log has the detail, including every fix that came out of review.

Where it is: work lands on `t3/jarvis-companion-assistant`, is reviewed by GPT-6.1 Sol until it comes back with nothing to fix, then goes into `dev`, which the installed yapd (`~/projects/yapd`) runs. The database was backed up before its first migration, to `~/.yapd/yapd.before-jarvis.sqlite`.

## Talk to it (the shortcut)

- The shortcut goes to one brain that knows your T3 Code threads: what each is doing, what it's called aloud, what you started it with and what yapd last said about it. Ask "what's going on?", "what's the Tezos one doing right now?", "who needs me?", "how much Claude have I got left?", "what did I miss?", "say that again", plain questions, or dictate new work as before.
- It picks the thread you mean by how it sounds and what it's about, so misheard names like "MiNAS SV2" or "my Tesla's migration" land first time. Nothing in yapd overrules its pick by matching words, which is what sank the reverted attempt.
- At most one question at a time, always naming what it's choosing between, never in the same words twice. Whatever you say next answers it or replaces it. Left unanswered, it's asked once more a minute later in other words, then let go with a word (your rule).
- "It" means what you were just listening to. Work it started in the last half hour isn't started twice.
- Tell a thread something ("tell the Tezos one to use the Mina fee table"): a busy one gets it in the turn under way, or in T3 Code's own queue when you say "when it's done", and yapd says which. It names the thread when it isn't the one you were just hearing about, and asks first only when it isn't sure which.
- "Stop the Tezos one" or "stop working", then "carry on" if you change your mind; "scratch that" withdraws a message still in the queue. A bare "stop" still only stops yapd talking.
- Nothing is ever sent twice behind your back: the same words to a thread that hasn't answered since get "I sent that a minute ago, sir. Again?", and a message yapd can't confirm got there, even across a restart, gets "Send it again?".
- Answers come before any update waiting to be read.
- `POST /utterances` takes a typed request the same way, for scripts and other apps.

## Faster

- "Yes" or "go ahead" to an update that asked something, and "thanks" or "skip it", are handled without the model: about two seconds saved on the most common replies.
- Short lines like "On it, sir." are rendered once and kept; your usual lines are written in your `YAPD_STYLE` once and rendered at startup.
- No more ~2 s wait for a fresh Codex thread after a quiet spell (one update in five); three are kept ready.
- The speaker gets ready while an update renders: about a second saved on nearly every update.
- "Who needs me?" and usage need no model call; a status question takes one, against a minute or more in the reverted attempt.

## Under the hood

- A versioned SQLite store in `~/.yapd/yapd.sqlite`, with a journal of everything heard, said and done. It survives restarts and feeds "what did I miss".
- A live link to T3 Code's threads that reconnects and catches up on its own, and actions on threads (message, steer, stop, approve, answer, archive, rename, snooze, search, usage). Messages, stops and starts by voice go through them now.
- Every message, stop and start is written down before it goes out, under ids that make T3 Code do it once however often it's sent. A restart only looks; it never sends.
- `scripts/m2-probe.ts` checks those T3 Code receipts once, on a thread it starts for itself; it sends nothing without `--send`.
- Groundwork, not switched on yet: an SSH tunnel to rig's T3 Code (token kept in memory only), and streaming plus first-sentence playback for faster speech.
- `scripts/brain-eval.ts` replays real phrases against the live model to check it picks the right thread.
