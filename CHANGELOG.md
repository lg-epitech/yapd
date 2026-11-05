# Changelog

## [0.4.0](https://github.com/lg-epitech/yapd/compare/v0.3.0...v0.4.0) (2026-11-05)


### Features

* **assistant:** add unified V2 voice loop ([92c82c9](https://github.com/lg-epitech/yapd/commit/92c82c9208889098b8d0cd6bc062d7a92f4d9f50))
* **assistant:** make V2 the default daemon ([137b668](https://github.com/lg-epitech/yapd/commit/137b66846b03374871c46728790930ac67e2cab2))
* **assistant:** merge V2 voice assistant ([35977e5](https://github.com/lg-epitech/yapd/commit/35977e58ee8bcb2f09a70a4f78c6afd80b47717c))
* **dictation:** send a shortcut's dictation once you stop talking ([c6d76d0](https://github.com/lg-epitech/yapd/commit/c6d76d043882212efad5a6d8ea4dd45cc911cfd4))
* **dictation:** send a shortcut's dictation once you stop talking, as the phone does ([58275d4](https://github.com/lg-epitech/yapd/commit/58275d43b48cffc2f5061462f1a7ae7f9a598a70))
* **ios:** drop a dictation from the Dynamic Island ([ae26b75](https://github.com/lg-epitech/yapd/commit/ae26b75399260ece06ebed509935429c89b55b50))
* **ios:** drop a dictation from the Dynamic Island ([0ea333c](https://github.com/lg-epitech/yapd/commit/0ea333cd615fbaea86acbb918de94f8901e88fd4))
* **ios:** drop a dictation from the Dynamic Island, as from the Lock Screen ([2e2d834](https://github.com/lg-epitech/yapd/commit/2e2d834074e63ff5963154c315eb510118c58930))
* **ios:** manual send only, mic off while yapd speaks ([3548f82](https://github.com/lg-epitech/yapd/commit/3548f82b823d82b047680d95e7eab985c966b42f))
* **ios:** round buttons alike on the Live Activity, with dropping a dictation at the far right ([b0e7858](https://github.com/lg-epitech/yapd/commit/b0e785817bf9c235edce29c83a26ebfecca9ea01))
* **ios:** round Live Activity buttons, cancel at the far right ([0b8f1ab](https://github.com/lg-epitech/yapd/commit/0b8f1ab797a133197490c5ecb1cfdd8a46379222))
* **ios:** round Live Activity buttons, cancel at the far right ([4b643f3](https://github.com/lg-epitech/yapd/commit/4b643f37f6631b98d5238f4772c4196173f9d9e4))
* **ios:** send a dictation once you stop talking ([0e2616e](https://github.com/lg-epitech/yapd/commit/0e2616e87549c8c4c5095d0df3b66c3311fb7464))
* **ios:** the phone sends only when pressed again, with its mic off while yapd speaks ([e3f0f72](https://github.com/lg-epitech/yapd/commit/e3f0f728c3f1d505375f3fab26f19117f0a1ab67))
* send dictations once you stop talking ([b4d5078](https://github.com/lg-epitech/yapd/commit/b4d5078bcb75935835101c02a4a060b7741009da))


### Bug Fixes

* **assistant:** keep V2 agent messages to what they need ([82250f6](https://github.com/lg-epitech/yapd/commit/82250f66a75fd92f78229e210c271123eafd1d62))
* **assistant:** restore settling and voice follow-ups ([68ad27d](https://github.com/lg-epitech/yapd/commit/68ad27d3143e932c9520c96713d98f8ca0c997f7))
* **assistant:** say Settled only once a thread has settled ([9097ba9](https://github.com/lg-epitech/yapd/commit/9097ba9f9d928235adc7298dc52f2f8bff38a1ec))
* **assistant:** shorten spoken settlement confirmations ([97e389b](https://github.com/lg-epitech/yapd/commit/97e389befa9654480229ba6bc958a45db0a15760))
* **ios:** a rest sent before a press leaves that press pending ([8f8dae9](https://github.com/lg-epitech/yapd/commit/8f8dae9b6a97d76d3b2f62b6762d5464d10a0eca))
* **ios:** end every background task once, the expiring one too, while a Live Activity is still going ([3baaabc](https://github.com/lg-epitech/yapd/commit/3baaabc5ead71c0538253aa7c0db30e05af70e2a))
* **ios:** end the Live Activity before letting go, and any left from before, so none stays behind saying yapd is ready ([91d6b28](https://github.com/lg-epitech/yapd/commit/91d6b28f17a27605c01c1ec5fca8ba4b47faa4cf))
* **ios:** the phone's mic opens only for its own dictation, and closes after an unanswered press ([5cb26b1](https://github.com/lg-epitech/yapd/commit/5cb26b1b19cac5366c2daa59c33f170749b1b7c6))
* **latest:** a row said again from the menu stops when he talks over it, as an answer he asked for does ([237205c](https://github.com/lg-epitech/yapd/commit/237205cad83ad0d696ae478de0562bc004e918d5))
* **latest:** menu replays stop when talked over ([55c726c](https://github.com/lg-epitech/yapd/commit/55c726c877c1558f9bd7b2aaa9912675c7165285))
* **launcher:** read settings from current T3 config ([daf8e6f](https://github.com/lg-epitech/yapd/commit/daf8e6f1969cb79b30070ffb370947f520b076e7))
* **voice:** recover failed captures and clear mic state ([d65a33c](https://github.com/lg-epitech/yapd/commit/d65a33c4b8a023b529ff9fdfa4e72844cdaca5d6))
* **voice:** render replies as speakable text ([e467c6a](https://github.com/lg-epitech/yapd/commit/e467c6a8d4e198ef05155f3ac3455bf14820f50f))
* **voice:** retain updates without replaying canceled speech ([d6aa964](https://github.com/lg-epitech/yapd/commit/d6aa9645dcd49be9d3e3a358afc397dd652d6e27))

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
