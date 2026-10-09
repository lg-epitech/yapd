# Jarvis: what changed

A short list of what this branch changed and what yapd can do now. The commit log has the detail, including every fix that came out of review.

Where it is: work lands on `t3/jarvis-companion-assistant`, is reviewed by GPT-6.1 Sol until nothing you'd run into is left (the narrowest findings go under "Known, left for now"), then goes into `dev`, which the installed yapd (`~/projects/yapd`) runs. The database was backed up before each step went live: `~/.yapd/yapd.before-jarvis.sqlite`, `yapd.before-m1.sqlite` and `yapd.before-m2.sqlite`.

Live on `dev` now: everything below. Cards for "show me" appear once the menu bar app is rebuilt from this branch; until then yapd says the gist without them. Being built: an agent's questions read out and answered by voice.

## Talk to it (the shortcut)

- The shortcut goes to one brain that knows your T3 Code threads: what each is doing, what it's called aloud, what you started it with and what yapd last said about it. Ask "what's going on?", "what's the Tezos one doing right now?", "who needs me?", "how much Claude have I got left?", "what did I miss?", "say that again", plain questions, or dictate new work as before.
- It picks the thread you mean by how it sounds and what it's about, so misheard names like "MiNAS SV2" or "my Tesla's migration" land first time. Nothing in yapd overrules its pick by matching words, which is what sank the reverted attempt.
- At most one question at a time, always naming what it's choosing between, never in the same words twice. Whatever you say next answers it or replaces it. Left unanswered, it's asked once more a minute later in other words, then let go with a word (your rule).
- "It" means what you were just listening to. Work it started in the last half hour isn't started twice.
- Tell a thread something ("tell the Tezos one to use the Mina fee table"): a busy one gets it in the turn under way, or in T3 Code's own queue when you say "when it's done" or the turn is waiting on you, and yapd says which. It names the thread when it isn't the one you were just hearing about, and asks first only when it isn't sure which.
- "Stop the Tezos one" or "stop working", then "carry on" if you change your mind; "scratch that" withdraws a message still in the queue. "Stop and do this instead" stops its turn, then tells it once it shows stopped; still busy fifteen seconds on, it isn't told, and yapd says so. If T3 Code holds it in the queue the stop held, yapd says so, and "carry on" lets it go. A bare "stop" still only stops yapd talking.
- "No, the Mina one" to its question does that instead, and "yes, but once it's done" or "yes, and then tell it…" does what you add. Two things in one breath ("stop the Tezos one and tell the Mina one…") are done in order, the first said at once; if one doesn't go, it says what it left.
- Nothing is ever sent twice behind your back: the same words to a thread that hasn't answered since get "I sent that a minute ago, sir. Again?", and a message yapd can't confirm got there, even across a restart, gets "Send it again?", to which saying the same words again is a yes.
- Answers come before any update waiting to be read.
- "Stop", "skip" or "enough" over an update skips it. "What did I miss?" leaves out what's about to be read anyway, and says how many are coming up.
- `POST /utterances` takes a typed request the same way, for scripts and other apps.

## Show me

- "Show me what's running", "show me that PR", "show me my usage" or "what I missed" puts a card in a panel under the menu bar icon as yapd says it; "hide that" takes it down, and "open that PR" opens it in your browser, https only. A thread waiting on a command that can't be read aloud gets its card with the answer, and "say that again" puts it back up.
- The API gains `/cards`, `/threads` and `/journal` to read from.

## Faster

- "Yes" or "go ahead" to an update that asked something, and "thanks" or "skip it", are handled without the model: about two seconds saved on the most common replies.
- Short lines like "Right away, sir." are rendered once and kept; your usual lines are written in your `YAPD_STYLE` once and rendered at startup.
- Your own lines for "on it", in `YAPD_ON_IT` separated by `|`, take turns in place of the written one when a reply is passed on, a message goes by voice or new work starts, never the same twice in a row.
- No more ~2 s wait for a fresh Codex thread after a quiet spell (one update in five); three are kept ready.
- The speaker gets ready while an update renders: about a second saved on nearly every update.
- "Who needs me?" and usage need no model call; a status question takes one, against a minute or more in the reverted attempt.

## Under the hood

- A versioned SQLite store in `~/.yapd/yapd.sqlite`, with a journal of everything heard, said and done. It survives restarts and feeds "what did I miss".
- A live link to T3 Code's threads that reconnects and catches up on its own, and actions on threads (message, steer, stop, approve, answer, archive, rename, snooze, search, usage). Messages, stops and starts by voice go through them now.
- Every message, stop and start is written down before it goes out, under ids that make T3 Code do it once however often it's sent. A restart only looks; it never sends. Turned off and on, nothing more goes out for what you said before.
- `scripts/m2-probe.ts` checks those T3 Code receipts once, on a thread it starts for itself; it sends nothing without `--send`, and `--thread` repeats only the restart check, on a thread it started.
- Groundwork, not switched on yet: an SSH tunnel to rig's T3 Code (token kept in memory only), and streaming plus first-sentence playback for faster speech.
- `scripts/brain-eval.ts` replays real phrases against the live model to check it picks the right thread.
- yapd's local API turns away anything a web page sends, so no site you visit can have it start work or talk to your threads.

## Known, left for now

- With exactly two lines of your own for going ahead, one picked for something that never plays can let the other come twice in a row.
- After a message was moved from the queue into the turn under way, "I sent that a minute ago. Again?" can be asked for its same words until ten minutes have passed.
- With an older yapd on rig, a connection dropped while starting work there is said as "I can't reach rig" rather than "it may have started".
- "Show Last Card" just after closing a card can come to nothing if the close reaches yapd after it: choose it again.
- A card closed while the app has lost touch with yapd is taken down when it's back, even if something else showed it again meanwhile.
