# yapd

A voice assistant for your coding work. Press the shortcut, ask about your T3 Code threads, dictate a task, or send a follow-up. Typed requests, voice and agent updates share one conversation, its context and the same tools.

V2 is the default assistant. It reasons through your existing Codex ChatGPT sign-in and uses self-hosted speech recognition and Kokoro speech. No separately billed model API key is required.

## Setup

You need Bun 1.3.13 or later, Codex signed in on the server, a running self-hosted recognizer, and a compatible T3 Code build with orchestration protocol 2 for thread tools. A Mac audio client needs Apple silicon and Xcode's command line tools.

```sh
bun add -g @launatic/yapd
codex login
yapd setup
```

Start your recognition service separately. The default multipart endpoint is `http://127.0.0.1:8792/v1/transcribe`; set `YAPD_V2_ASR_URL` in `~/.yapd/.env` for another endpoint. Setup installs hooks and the background service, then runs `yapd doctor`. It does not install an ASR server. Codex may ask you to trust the hooks.

For a Linux server, use `yapd setup server`. On the Mac, use `yapd setup client me@server`. The server handles reasoning and tools; the clients supply microphone audio and play speech. Pair a phone with `yapd pair`, then build/install its app with `bun run phone` from a checkout. Existing pairing and settings survive an update.

Put your T3 Code token in `~/.yapd/.env` as `YAPD_T3CODE_TOKEN`. [The setup guide](docs/guide.md#v2) covers recognition options, T3 Code access and troubleshooting.

To update:

```sh
bun add -g @launatic/yapd@latest
yapd install
```

`yapd serve` runs V2 in the foreground. `yapd v2` remains an alias. The previous assistant is available explicitly as `yapd v1`.

## One conversation

Ask what's happening, which threads need you, or what changed. Search and read threads, answer their questions, send follow-ups, launch new work, or settle a completed thread. Each request has the same tools and conversation context. Exact actions retain their receipts, and a queued action is not treated as completed work.

The default reasoner is `gpt-6.1-sol` at low effort. `YAPD_BRAIN_MODEL` and `YAPD_BRAIN_EFFORT` override it. When `YAPD_PROVIDER` is Codex (the default), `YAPD_MODEL`, `YAPD_EFFORT` and `YAPD_TIER` remain fallbacks; other providers’ values are ignored. Messages to other agents contain the instructions and constraints they need. Spoken replies are conversational; a Markdown fallback removes formatting from speech while preserving the visible transcript.

On Mac, a conversation keeps listening between replies. Ask it to stop listening, press Escape, or turn yapd off to end it. A notification alone does not open an ongoing conversation. On the phone, press to record and press Send; the microphone closes before the answer.

Talking over an update stops its audio. A new request or manual cancellation never restarts the canceled reply. Useful unheard notification facts stay available for a relevant follow-up or catch-up. False speech onsets may resume the same attempt. Stop dismisses current and queued announcements; a requested catch-up clears its facts only after confirmed full playback.

## Speech and the menu bar

Kokoro speaks stable phrases while the answer continues generating. Multipart recognition uploads provisional prefixes while you speak; these are previews, not native streaming inference. Only the final committed transcript can authorize work. English speech output and French recognition are supported.

A pinned CPU streaming recognizer is available on Linux x86-64:

```sh
yapd v2-asr --download
```

Run that server in its own terminal, set `YAPD_V2_ASR_WS_URL=ws://127.0.0.1:8769/v1/audio/transcriptions/realtime` in yapd's settings, then run `yapd install`. The explicit download is about 752 MB; subsequent starts use the cache. [More details](docs/guide.md#v2).

The [menu bar app](https://github.com/lg-epitech/yapd/releases/latest) shows activity and threads, controls power and displays cards such as a PR you asked to see. It is not notarized, so macOS may require Open Anyway in Privacy & Security. The optional conversation page is `/v2`, protected by your pairing token.

Legacy focus/quiet modes, routines, reminders and direct terminal-agent reply behavior belong to V1. Its settings and controls remain documented in the [V1 reference](docs/guide.md#v1-reference).

## Development

```sh
bun install
bun run check
bun test
```

`bun scripts/v2-eval.ts --list` lists the text/tool scenarios. Use `--run --only contextual-target,constraints` for a small Codex-subscription-backed subset with synthetic tools. These checks do not measure real microphone latency or speaker timing. The [V2 ticket](https://github.com/lg-epitech/yapd/issues/60) records the design, verification and experience checks.
