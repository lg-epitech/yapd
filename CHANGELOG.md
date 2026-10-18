# Changelog

## [0.4.0](https://github.com/lg-epitech/yapd/compare/v0.3.0...v0.4.0) (2026-10-18)


### Features

* **dictation:** send a shortcut's dictation once you stop talking ([c6d76d0](https://github.com/lg-epitech/yapd/commit/c6d76d043882212efad5a6d8ea4dd45cc911cfd4))
* **dictation:** send a shortcut's dictation once you stop talking, as the phone does ([58275d4](https://github.com/lg-epitech/yapd/commit/58275d43b48cffc2f5061462f1a7ae7f9a598a70))
* **ios:** drop a dictation from the Dynamic Island ([ae26b75](https://github.com/lg-epitech/yapd/commit/ae26b75399260ece06ebed509935429c89b55b50))
* **ios:** drop a dictation from the Dynamic Island ([0ea333c](https://github.com/lg-epitech/yapd/commit/0ea333cd615fbaea86acbb918de94f8901e88fd4))
* **ios:** drop a dictation from the Dynamic Island, as from the Lock Screen ([2e2d834](https://github.com/lg-epitech/yapd/commit/2e2d834074e63ff5963154c315eb510118c58930))
* **ios:** round buttons alike on the Live Activity, with dropping a dictation at the far right ([b0e7858](https://github.com/lg-epitech/yapd/commit/b0e785817bf9c235edce29c83a26ebfecca9ea01))
* **ios:** round Live Activity buttons, cancel at the far right ([0b8f1ab](https://github.com/lg-epitech/yapd/commit/0b8f1ab797a133197490c5ecb1cfdd8a46379222))
* **ios:** round Live Activity buttons, cancel at the far right ([4b643f3](https://github.com/lg-epitech/yapd/commit/4b643f37f6631b98d5238f4772c4196173f9d9e4))
* **ios:** send a dictation once you stop talking ([0e2616e](https://github.com/lg-epitech/yapd/commit/0e2616e87549c8c4c5095d0df3b66c3311fb7464))
* send dictations once you stop talking ([b4d5078](https://github.com/lg-epitech/yapd/commit/b4d5078bcb75935835101c02a4a060b7741009da))


### Bug Fixes

* **ios:** end every background task once, the expiring one too, while a Live Activity is still going ([3baaabc](https://github.com/lg-epitech/yapd/commit/3baaabc5ead71c0538253aa7c0db30e05af70e2a))
* **ios:** end the Live Activity before letting go, and any left from before, so none stays behind saying yapd is ready ([91d6b28](https://github.com/lg-epitech/yapd/commit/91d6b28f17a27605c01c1ec5fca8ba4b47faa4cf))

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
