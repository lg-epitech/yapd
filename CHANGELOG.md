# Changelog

## [0.3.0](https://github.com/lg-epitech/yapd/compare/v0.2.0...v0.3.0) (2026-10-18)

yapd can now run on an always-on machine and talk to you through your Mac or your iPhone.

- `yapd setup server` on the server, Linux included, and `yapd setup client me@server` on each Mac. The server does the work and the Mac only plays and listens, so it can close without taking yapd with it.
- An iPhone app: `yapd pair`, then `bun run phone` to install it. Press its button, or the Action button, to talk to yapd over Tailscale.
- Catch-ups go a thread at a time, and leave out what a thread's later updates overtook, like a question since answered.
- On a fast CPU, a line starts playing while the rest of it renders.

## [0.2.0](https://github.com/lg-epitech/yapd/compare/v0.1.0...v0.2.0) (2026-10-15)

yapd is now an assistant you talk to, not just a voice for your agents' updates.

- Press the shortcut to ask about any of your T3 Code threads: "what's going on?", "who needs me?", "catch me up", "show me that PR". Tell a thread what to do, or dictate new work, including threads that look something up and report back.
- Updates come headline first, and "more" gives you the rest. Agents' questions are read out, and you answer by voice.
- Mute a noisy thread, say "focus" or "goodnight", or turn yapd off. Off keeps everything for a catch-up, and "Mute." on its own turns yapd off at once.
- Reminders, memories, routines and tidying threads, all by voice.
- Agents on another machine, with its T3 Code threads beside yours.
- The menu bar app lists your threads to hear again or mute, sets focus or quiet, catches you up and shows the cards you ask for.
- Faster: lines start playing after their first sentence, what you say is transcribed as you pause, and new work is confirmed sooner.

Needs T3 Code 0.0.46 or later (for now the nightly) and a token from it. The README has the rest.
