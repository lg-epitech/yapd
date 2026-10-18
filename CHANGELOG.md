# Changelog

## [0.3.0](https://github.com/lg-epitech/yapd/compare/v0.2.0...v0.3.0) (2026-10-18)


### Features

* **assistant:** catch-ups told a thread at a time ([23476f3](https://github.com/lg-epitech/yapd/commit/23476f3b10ff491c1444f201dfe8aff712532642))
* **assistant:** catch-ups told a thread at a time ([16ec1da](https://github.com/lg-epitech/yapd/commit/16ec1da9def30c0f9c4573141c7e2e30eab2cb72))
* **assistant:** tell a catch-up a thread at a time, leaving out what a thread's later updates overtook ([a1cb4fb](https://github.com/lg-epitech/yapd/commit/a1cb4fbce49febe1ad46fbdbcc71d3ed15266e42))
* **audio:** play and hear through devices that connect to yapd over /audio ([6b7cf11](https://github.com/lg-epitech/yapd/commit/6b7cf11a575a5005a363ad8689875b432a2aa2f8))
* **clients:** a server with no time zone set tells the time in the first client's ([1d2883f](https://github.com/lg-epitech/yapd/commit/1d2883f2353fc07399b19ddb7f762a93e85f0509))
* **dictation:** hear a phone from the press, without waiting for the note to reach it ([cf9fa10](https://github.com/lg-epitech/yapd/commit/cf9fa100677e1a4589dd577b1075dd7bdb4c1f60))
* **ios:** an iPhone app that talks to yapd from the Action button ([4b9bfe2](https://github.com/lg-epitech/yapd/commit/4b9bfe20527cc6890c441f63747bb9c4f18f3e88))
* **ios:** bun run phone builds the app and installs it on your iPhone ([e1c5e44](https://github.com/lg-epitech/yapd/commit/e1c5e4459542ffc31f30d61ac87b717944b1e5da))
* **ios:** dark only, like the arc reactor ([4f9038c](https://github.com/lg-epitech/yapd/commit/4f9038c84ca939405f394caa9e0ee44153b8e432))
* **ios:** the arc reactor in place of the mic, in its menu bar forms, and keep reconnecting while on screen ([e0f5752](https://github.com/lg-epitech/yapd/commit/e0f57527522c2193fe6ad194fe798dc4ffa87678))
* run yapd on a server, with clients and an iPhone app ([696883d](https://github.com/lg-epitech/yapd/commit/696883d9aa45c2f46fd845c5f944525ded247ba5))
* run yapd on a server, with clients and an iPhone app ([63640a2](https://github.com/lg-epitech/yapd/commit/63640a234498607b5d81edc7343fe7144b7e6cd4))
* **server:** listen on the tailnet for what bears a paired token ([ea7f323](https://github.com/lg-epitech/yapd/commit/ea7f323d797e423a0a3cef4997b94582b1196d54))
* **voice:** play a line's first part while the rest renders on a fast CPU ([58f964f](https://github.com/lg-epitech/yapd/commit/58f964f3156e3a08cae86dd2fa957fe8b1742d7c))
* yapd setup server and yapd setup client, with clients joined over SSH ([1bfec68](https://github.com/lg-epitech/yapd/commit/1bfec68d624ef73ae10205438da8ee38f7c48121))


### Bug Fixes

* **audio:** let a client go without waiting in its socket's callback, which crashed yapd when one left while it was heard ([6695993](https://github.com/lg-epitech/yapd/commit/6695993449ed803cf1813574ae1ac8737e50c063))
* **audio:** until something is pressed, speak on a Mac before a phone that reconnected first ([f37bef1](https://github.com/lg-epitech/yapd/commit/f37bef1564c060c643eb7a118bd2c752fcf4b068))
* cut off a client that never stops, let go of Escape with a lost dictation, keep a muted client's voice, and pair again after Tailscale comes up ([7e2fe3f](https://github.com/lg-epitech/yapd/commit/7e2fe3f720223a71f4ff3bade3b62fe6aff99e26))
* **hook:** read a client's name from its settings, so its hooks' commands and Codex's trust in them stay as they were ([7c536b6](https://github.com/lg-epitech/yapd/commit/7c536b65387556c777299ef86852d199132ac8ab))
* **ios:** bun run phone finds the team from its certificate and registers the phone with it ([8e8e185](https://github.com/lg-epitech/yapd/commit/8e8e185ee0dfd9f3cf2b084dcd0582c91b99fe64))
* **ios:** bun run phone only installs on a real iPhone ([f653050](https://github.com/lg-epitech/yapd/commit/f65305088b8fbaea3057c043c403d15f089105cf))
* **ios:** close the microphone when yapd can't be reached, and reconnect while on screen ([be2587e](https://github.com/lg-epitech/yapd/commit/be2587ecd11947cf5ba78349a22ac71a0e878d23))
* **ios:** start the Live Activity the Action button records under, stay awake until letting go, and give other apps their audio back ([6383bb9](https://github.com/lg-epitech/yapd/commit/6383bb96d397dfa138bd7dbc56a547e42384a477))
* **ios:** stay connected while yapd is still at work ([94d975c](https://github.com/lg-epitech/yapd/commit/94d975cf16fed666d6f26e8eab0f63f04e44d901))
* **ios:** stay connected while yapd is still at work ([a0a8777](https://github.com/lg-epitech/yapd/commit/a0a8777bc27a2903176289279b5869e37e1f4f6e))
* **ios:** stay connected while yapd is still at work, so its answer after "one moment" isn't lost ([159b78f](https://github.com/lg-epitech/yapd/commit/159b78fb43682e78995e59403779b6db1d5d0537))
* **service:** systemd takes WorkingDirectory unquoted ([084b50b](https://github.com/lg-epitech/yapd/commit/084b50bdb316206cc903ebb0ad9a9911374c47a0))

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
