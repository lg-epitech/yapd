# Jarvis: what changed

A running list of what this branch changed and what yapd can do now, for review. Newest at the bottom of each section.

Where it is: work lands on `t3/jarvis-companion-assistant`, is reviewed by GPT-6.1 Sol until it comes back with nothing to fix, and is then merged into `dev`, which the installed yapd (`~/projects/yapd`) runs. The first batch took eight review rounds and went live on 2026-10-08. The database was backed up first, to `~/.yapd/yapd.before-jarvis.sqlite`.

## Faster

- Short lines it says over and over, like "On it, sir.", are rendered once and kept, so they play at once instead of waiting about a second for Kokoro each time.
- Its usual lines (taking something in hand, queuing it, not catching what you said, looking something up) are written once in your `YAPD_STYLE` and kept in its database, then rendered at startup, so even the first one is instant.
- The replies that need no thought are answered without the model, which saves about two seconds on the most common exchanges: "yes" or "go ahead" to an update that asked something goes straight to the agent, and "thanks", "got it", "skip it" or "quiet" just end the update. Anything more than that still goes to the model.

- After a quiet spell, the first update or reply no longer waits about two extra seconds for Codex to set up a thread: the ready ones are replaced every quarter of an hour, before they'd be too old to trust. That was one update in five.

- The speaker gets ready while an update is still being rendered, instead of after, which took macOS about a second on nearly every update. If nothing comes after all, it rests again within fifteen seconds.

- Nothing in a short line's speech cache can be left half-rendered, leak files, or hold shutdown up (found and fixed in review).

## Smarter

## More capable

- yapd can follow every T3 Code thread live: what's running, what's waiting on you, what just failed, and when a thread asks something mid-turn, which no hook reports. It reconnects on its own and catches up on what happened while it was away. Not used yet: the assistant that speaks from it comes next.
- yapd can act on T3 Code threads: read where one got to and what it's asking, message it (into the running turn, or after it), stop it, approve or deny what it asks, answer its questions, archive, rename, snooze, search them, and read your usage limits. Not used by voice yet either.

## Under the hood

- The settings table now holds anything yapd works out once and keeps, not just whether it's on.
- A versioned SQLite store (`~/.yapd/yapd.sqlite`) again, with the migration runner from the reverted threads work. Its two shipped steps are kept as they were, so a database already at version 2 carries on, and step 3 adds the journal. Checked against a copy of a real version 2 database: settings and the 42 thread rows survived.
- A journal of everything heard, said and done: each update with the agent's message and the prompt, each reply and what it meant, each message sent to an agent, and each piece of work started. What the prompt writer reads as "what you read out lately" now comes from it, so it survives a restart.
- Groundwork for rig as a first-class machine: `yapd t3` says where a machine's T3 Code listens and its token, and a tunnel keeps one SSH connection open to rig with a forward to its T3 Code, so rig's threads can be followed and acted on like Rosie's, about ten times faster than an SSH round trip each time. The token stays in memory only. Not switched on yet.
- Groundwork for speed: yapd can read the model's answer field by field and sentence by sentence while it's still being written, Codex's answers can be streamed, and Kokoro can hand over an update's first sentence to start playing while the rest renders. Not switched on yet.
