# Jarvis: what changed

A running list of what this branch changed and what yapd can do now, for review. Newest at the bottom of each section.

## Faster

- Short lines it says over and over, like "On it, sir.", are rendered once and kept, so they play at once instead of waiting about a second for Kokoro each time.
- Its usual lines (taking something in hand, queuing it, not catching what you said, looking something up) are written once in your `YAPD_STYLE` and kept in its database, then rendered at startup, so even the first one is instant.
- The replies that need no thought are answered without the model, which saves about two seconds on the most common exchanges: "yes" or "go ahead" to an update that asked something goes straight to the agent, and "thanks", "got it", "skip it" or "quiet" just end the update. Anything more than that still goes to the model.

- After a quiet spell, the first update or reply no longer waits about two extra seconds for Codex to set up a thread: the ready ones are replaced every quarter of an hour, before they'd be too old to trust. That was one update in five.

## Smarter

## More capable

## Under the hood

- The settings table now holds anything yapd works out once and keeps, not just whether it's on.
- A versioned SQLite store (`~/.yapd/yapd.sqlite`) again, with the migration runner from the reverted threads work. Its two shipped steps are kept as they were, so a database already at version 2 carries on, and step 3 adds the journal. Checked against a copy of a real version 2 database: settings and the 42 thread rows survived.
- A journal of everything heard, said and done: each update with the agent's message and the prompt, each reply and what it meant, each message sent to an agent, and each piece of work started. What the prompt writer reads as "what you read out lately" now comes from it, so it survives a restart.
