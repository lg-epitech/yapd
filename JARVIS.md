# Jarvis: what changed

A running list of what this branch changed and what yapd can do now, for review. Newest at the bottom of each section.

## Faster

- Short lines it says over and over, like "On it, sir.", are rendered once and kept, so they play at once instead of waiting about a second for Kokoro each time.
- Its usual lines (taking something in hand, queuing it, not catching what you said, looking something up) are written once in your `YAPD_STYLE` and kept in its database, then rendered at startup, so even the first one is instant.
- The replies that need no thought are answered without the model, which saves about two seconds on the most common exchanges: "yes" or "go ahead" to an update that asked something goes straight to the agent, and "thanks", "got it", "skip it" or "quiet" just end the update. Anything more than that still goes to the model.

- After a quiet spell, the first update or reply no longer waits about two extra seconds for Codex to set up a thread: the ready ones are replaced every quarter of an hour, before they'd be too old to trust. That was one update in five.

- The speaker gets ready while an update is still being rendered, instead of after, which took macOS about a second on nearly every update. If nothing comes after all, it rests again within fifteen seconds.
- "What's going on?" by the shortcut is answered from what yapd already follows of T3 Code, in about one model call, rather than the minute or more the reverted attempt took. "Who needs me?" and "how's my usage?" need no model at all.
- Starting work doesn't wait for one model call and then another: the prompt is written while yapd works out that it's new work.
- What you dictated is transcribed while the "sent" sound plays, not after it, and the speaker gets ready while the answer is worked out.
- Three Codex threads are kept ready instead of two, so working out a dictation, writing its prompt and summing up an update at the same moment don't wait for a new one.

## Smarter

- The shortcut goes to one brain that knows your threads: what each is doing, what it's called aloud, what you started it with and what yapd last said about it. It picks the thread you mean by how it sounds and what it's about, so "status on MiNAS SV2" or "my Tesla's migration" get the right thread first time, and nothing in yapd overrules its pick by matching words.
- At most one question at a time, and it always names the threads it's choosing between. Whatever you say next, by the shortcut or over it, answers it or takes its place, so it's never asked alongside a newer request, and it's never asked in the same words twice. Left unanswered, it's asked once more a minute later in other words, then let go with a word. A second question about the same request is never asked: yapd leaves it.
- "It" means what you were just listening to, or the last thing heard within a quarter of an hour.
- The names in your busiest threads' titles are among the words Whisper listens for when you dictate.
- What yapd says when it holds a reply back talks about the work, never a session: "You've moved on from that since, so I held it back."

## More capable

- By the shortcut: "what's going on", "what's the Tezos one doing right now" (which reads the thread first), "who needs me", "how much Claude have I got left", "what did I miss", "say that again", plain questions, and starting work as before. What it can't do yet, like messaging a thread, gets "I can't do that yet".
- `POST /utterances` takes a typed request the same way as a dictation, for scripts and other apps (see `docs/api.md`).

## Under the hood

- The settings table now holds anything yapd works out once and keeps, not just whether it's on.
- A versioned SQLite store (`~/.yapd/yapd.sqlite`) again, with the migration runner from the reverted threads work. Its two shipped steps are kept as they were, so a database already at version 2 carries on, and step 3 adds the journal. Checked against a copy of a real version 2 database: settings and the 42 thread rows survived.
- A journal of everything heard, said and done: each update with the agent's message and the prompt, each reply and what it meant, each message sent to an agent, and each piece of work started. What the prompt writer reads as "what you read out lately" now comes from it, so it survives a restart.
- The journal names machines the way you do, notes which updates you heard through, keeps what must only be said once, and forgets what's over a year old. Work yapd starts is noted with what it's about, which is what it's called aloud from then on.
- New work no longer keeps questions of its own: what's left of drafts starts the work, and the one open question lives with the brain.
- `scripts/brain-eval.ts` replays phrases against the live model, from a copy of your own threads written under `~/.yapd/eval/`, and times `orchestration.searchThreads`.
