# API

yapd serves a small HTTP API on the port its hooks use, `127.0.0.1:4747` unless `YAPD_PORT` says otherwise. The [menu bar app](../README.md#menu-bar) only uses this API, so your own UI can do everything it does: a status bar module on Linux, a Stream Deck button, a script.

It only listens on localhost. From another machine, forward the port over SSH, like `ssh -N -L 4747:127.0.0.1:4747 mac`. A machine whose hooks already reach yapd through a [reverse tunnel](../README.md#agents-on-another-machine) can use the API at the same address.

There's no authentication: anything that can reach the port can use it, as hooks do. Requests have to be addressed to `127.0.0.1`, `localhost` or `[::1]`, so a web page can't get in through a domain name of its own that points here, and a page from anywhere else can't read the responses, since yapd sends no CORS headers. Anything a browser marks as sent by a page, with an `Origin` header or a `Sec-Fetch-Site` other than `none`, is turned away too, so no page can have yapd act for it by posting blind; apps, scripts and `curl` send neither.

## State

`GET /state`

```json
{
  "on": true,
  "activity": "speaking",
  "updates": [
    {
      "id": "4b9f2c1e-7d3a-4f0b-9a51-0c2e8d6f1a77",
      "project": "yapd",
      "text": "yapd. The tests pass and the PR is up.",
      "at": "2026-10-02T14:03:11.000Z"
    }
  ],
  "showing": {
    "id": "cmgi3k2xa4f1",
    "kind": "pr",
    "title": "Migrate the Tezos integration",
    "at": "2026-10-02T14:05:40.000Z"
  }
}
```

- `on`: whether yapd is on. While it's off, it says nothing, never opens the microphone and lets go of the dictation shortcut. Updates that finish meanwhile are never said, not even later.
- `activity`: `speaking` while yapd plays something, `listening` while the microphone is open without it, for a reply after an update or while you dictate, and `idle` otherwise.
- `updates`: the last five updates yapd said, newest first, to [hear again](#hearing-an-update-again). `text` is what it said and `at` when the agent's turn ended. They're forgotten when yapd restarts.
- `showing`: the [card](#cards) yapd is showing, or `null`. `kind` and `title` are the card's, and `at` is when yapd put it up. Fetch the card itself from `/cards/{id}`. A yapd from before cards doesn't send it at all.

The menu bar app's icon shows "not running" when it can't reach the API, "off" when `on` is false, and `activity` otherwise. A card that's showing opens in a panel under the icon.

## Following changes

`GET /state/stream` sends the state as [server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html), one `data:` line of JSON right away and another each time it changes. Nothing is sent while nothing changes, so don't time out reads, and connect again when the connection drops, like when yapd restarts.

This prints `off`, `idle`, `speaking` or `listening` each time it changes, which is what a status bar module needs:

```sh
curl -sN http://127.0.0.1:4747/state/stream | sed -un 's/^data: //p' | jq --unbuffered -r 'if .on then .activity else "off" end'
```

A UI that shows yapd's [cards](#cards), like the menu bar app, follows `/state/stream?cards` instead. While one does, yapd takes what it puts up to be on your screen, and says so.

## Turning yapd on and off

`PUT /state` with `{"on": false}` or `{"on": true}` as JSON returns the new state. It stays that way when yapd restarts.

```sh
curl -X PUT -H 'Content-Type: application/json' -d '{"on": false}' http://127.0.0.1:4747/state
```

Turning it off stops whatever yapd is saying at once, and drops whatever hasn't started yet: what was waiting to be said, a dictation being recorded or transcribed, and new work still being written up or waiting on an answer. A session already being started still starts, but nothing is said about it.

## Hearing an update again

`POST /updates/{id}/replay` says an update again, as it was said, without summing it up again. It goes ahead of updates that don't need you. You can reply to it like to any update, and a reply only goes to the agent if its session hasn't moved on since.

| Status | |
| --- | --- |
| `202` | It's been queued. |
| `404` | No such update. |
| `409` | yapd is off. |

## Asking yapd something

`POST /utterances` with `{"text": "who needs me?"}` as JSON takes what you typed as if you'd said it by the shortcut: yapd works out what you meant, does it, and says what came of it ahead of anything else. It answers once yapd has acted on it, with the request's id, the same one its log lines carry. That's a few seconds of the model for most requests. New work answers once it's been asked of T3 Code, and whether it started is said when T3 Code has it ready, which can take minutes in a worktree. A request waits for one still being worked out, so give it a generous timeout.

```sh
curl -X POST -H 'Content-Type: application/json' -d '{"text": "what is going on?"}' http://127.0.0.1:4747/utterances
```

| Status | |
| --- | --- |
| `202` | `{"id": "u…"}`: it's been acted on, and what came of it is waiting to be said. |
| `400` | There's no text. |
| `409` | yapd is off. |

It can tell you what your threads are doing, who needs you, how much of your usage is left, what you missed, and say again what it just said, it can [show you things](#cards), and it can start new work, send a thread a message, now or once its current task is done, stop a thread, let it carry on, and take back a message still waiting in the queue. The same words to a thread that hasn't answered since are asked about rather than sent again. Anything else that would change a thread, like approving what it asks or archiving it, it answers with "I can't do that yet" for now. A question it asks you, like which of two threads you meant or whether to send something again, is answered by speaking over it or right after, or by asking again here.

## Cards

Ask yapd to show you something, like "show me that PR", "show me what's running", "show me my usage" or "show me what I missed", and it puts a card up and says what's on it in a line, adding "it's on your screen" only if a UI that shows cards, like the menu bar app, follows [`/state/stream?cards`](#following-changes) when the line is said. "Hide that" takes the card down. "Show me that PR" also opens the pull request in your browser. yapd only ever opens an `https` address that came from T3 Code, never one a model wrote.

When you ask about a thread that waits on something that can't be read aloud, like a command it wants to run, yapd puts that thread's card up with its answer. "Say that again" also puts a card up while a UI that shows cards follows the state: the one that went up with what it says again, anew, so it stays up while that's said, or else what it said and what it heard you say last. Once yapd has been turned off and on, it doesn't say again what it said before, nor put its card back up.

`GET /cards/{id}` returns one of the last twenty cards, by the `id` in `showing`:

```json
{
  "id": "cmgi3k2xa4f1",
  "kind": "pr",
  "title": "Migrate the Tezos integration",
  "markdown": "**#412** in lg-epitech/integration, open\n\n- Checks: passing\n- Review: waiting for a review\n- Mergeable: yes\n- Thread: Migrate the Tezos integration\n\n[Open the pull request](<https://github.com/lg-epitech/integration/pull/412>)",
  "url": "https://github.com/lg-epitech/integration/pull/412",
  "caption": "Checks pass and it's waiting for a review, sir.",
  "at": "2026-10-02T14:05:40.000Z"
}
```

- `kind`: `threads` for what's going on across your threads, grouped by what they're doing, `thread` for one thread, `pr` for a pull request, `usage` for your limits and when they reset, `list` for what you missed, and `said` for the last line yapd said and the last thing it heard you say.
- `markdown`: the card, in Markdown. What a thread waits on is always in a code block, as text, never as a link. Code blocks start only at the very start of a line, fenced with more backticks than any run of them inside, and no other line starts one, indented or not. Links in a thread's own messages are kept only when they're `https`, with the host they go to written after them unless their words are the address itself, and anything else that would make one, like a definition or an address in angle brackets, is escaped. An address written out bare is left as text, which some renderers make a link of, so follow only `https` links, as the menu bar app does.
- `url`: the address the card is about, only ever `https` and from T3 Code, like the pull request's. Missing when there's none.
- `caption`: what yapd said with it, without "it's on your screen". Missing when it said nothing.

| Status | |
| --- | --- |
| `200` | The card. |
| `404` | No such card, or yapd restarted since. |

`DELETE /cards/current` takes the card down, so `showing` becomes `null`. It answers `204`, whether or not one was up.

`PUT /cards/current` with one of those cards' `id` puts it back up, as the menu's Show Last Card does, so `showing` points at it again and "hide that" takes it down. Nothing is said of it.

```sh
curl -X PUT -H 'Content-Type: application/json' -d '{"id": "cmgi3k2xa4f1"}' http://127.0.0.1:4747/cards/current
```

| Status | |
| --- | --- |
| `204` | It's up again. |
| `400` | There's no `id`. |
| `404` | No such card, or yapd restarted since. |

## Threads

`GET /threads` lists the threads yapd can see, by machine, those that need you first:

```json
[
  {
    "machine": "Rosie",
    "threads": [
      {
        "id": "850299f8-3b2a-4c1d-8e7f-6a5b4c3d2e1f",
        "project": "integration",
        "title": "Migrate the Tezos integration",
        "state": "running",
        "since": "2026-10-02T13:40:00.000Z",
        "pr": { "number": 412, "url": "https://github.com/lg-epitech/integration/pull/412", "state": "open", "checks": "passing" }
      }
    ]
  },
  { "machine": "rig", "reason": "I can't see rig's threads yet.", "threads": [] }
]
```

- `reason`: why a machine's threads can't be seen right now, like T3 Code not running. Its `threads` are empty then.
- `state`: `approval` or `question` when the thread waits on you, `running`, `finishing`, `queued`, `failed`, `limited` when it hit a usage limit, or `idle`. `since` is when it got there.
- `pr`: its latest pull request, when it has one. `url` is only ever `https`, and missing when the address T3 Code has for it isn't. `state`, `checks`, `review` and `mergeability` are there when T3 Code knows them.

Archived threads and the ones a thread runs for itself aren't listed. Nothing here changes a thread: ask yapd through [`/utterances`](#asking-yapd-something), so the same rules apply as when you speak.

## Journal

`GET /journal` returns what yapd heard, said and did, newest first, as it keeps it for a year:

```json
[
  {
    "id": 1872,
    "at": "2026-10-02T14:03:11.000Z",
    "kind": "update",
    "machine": "Rosie",
    "project": "yapd",
    "said": "yapd. The tests pass and the PR is up.",
    "heard": "2026-10-02T14:03:20.000Z"
  }
]
```

- `kind`: `update` for an agent's turn yapd summed up, `reply` for what you said back to one, `dictation` for what you dictated or typed, `answer` for what yapd answered, `started` for work it started, `sent` for a message it passed on, `notice` for something it brought up itself, and `action` for anything else it did, like turning off.
- `said` is what yapd said, `text` the words it was about, like what you said or an agent's message, and `heard` when you heard it through.
- `machine` and `project` are where it happened, `thread` the id of the T3 Code thread it's about, as [`/threads`](#threads) has it, and `utterance` the id of the request it came from, as [`/utterances`](#asking-yapd-something) gives it.
- Each is there only when there's one.

| Query | |
| --- | --- |
| `limit` | How many, 50 unless you say, 200 at most. |
| `before` | Only entries older than the one with this `id`: pass the last `id` you got for the next page. |
| `kind` | Only these kinds, comma-separated, like `update,answer`. |

It answers `400` when a query can't be read.

## Errors

Besides those, `400` means the body couldn't be read, `403` that the request was addressed to another host or came from a web page, and `500` that something went wrong in yapd, which its log says more about. `GET /health` answers `ok` while yapd runs.

`POST /events` is for the hooks, and isn't part of this API.
