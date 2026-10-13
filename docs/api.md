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
  "mode": "focus",
  "until": "2026-10-02T15:00:00.000Z",
  "waiting": 1,
  "unheard": 6,
  "updates": [
    {
      "id": "1872",
      "project": "yapd",
      "text": "yapd. The tests pass and the PR is up.",
      "at": "2026-10-02T14:03:11.000Z"
    }
  ],
  "recent": [
    {
      "key": "t3:Rosie:850299f8-3b2a-4c1d-8e7f-6a5b4c3d2e1f",
      "machine": "Rosie",
      "thread": "850299f8-3b2a-4c1d-8e7f-6a5b4c3d2e1f",
      "title": "Migrate the Tezos integration",
      "project": {
        "name": "integration",
        "id": "5c1e9a40-2d7b-4e3f-8a61-9b0c7d2e4f13",
        "icon": { "kind": "image", "url": "/projects/Rosie/5c1e9a40-2d7b-4e3f-8a61-9b0c7d2e4f13/icon", "revision": "9f2c4e1a7b3d", "text": "IN", "color": "indigo" }
      },
      "text": "integration. The migration is done and the tests pass.",
      "at": "2026-10-02T14:01:40.000Z",
      "muted": false,
      "waiting": false,
      "replayable": true,
      "unheard": 2
    }
  ],
  "showing": {
    "id": "cmgi3k2xa4f1",
    "kind": "pr",
    "title": "Migrate the Tezos integration",
    "at": "2026-10-02T14:05:40.000Z",
    "revision": 6
  },
  "revision": 7
}
```

- `on`: whether yapd is on. While it's off, it says nothing of its own accord and never opens the microphone to listen for a reply. The dictation shortcut still works: what you ask is answered, then it's quiet again. What finishes meanwhile is still summed up and kept unheard, for the menu and for [catching up](#catching-up); it's never said on its own, not even once it's back on. Turned back on with any of that new since it was last on, it says "You missed five, sir. Want the rundown?" once, counting what's still unheard of every time it was off that week, and a yes gives you the catch-up; anything else, or nothing, lets it go without a word, and it isn't asked again. Agents' questions still waiting are asked once it's on, as before.
- `activity`: `speaking` while yapd plays something, `listening` while the microphone is open without it, for a reply after an update or while you dictate, and `idle` otherwise.
- `mode`: how yapd talks of its own accord. `normal` says what finished and what needs you; `focus` and `quiet` say only what needs you, and hold the rest for later. See [Modes](#modes). A yapd from before modes doesn't send it: take that as `normal`.
- `until`: when `focus` or `quiet` ends on its own, only while one is on.
- `waiting`: how many threads wait on you for an approval or an answer, on every machine whose threads yapd can see. A yapd from before it doesn't send it: take that as `0`.
- `unheard`: how many updates and notices a [catch-up](#catching-up) would tell you of now, muted threads aside, not counting what yapd is reading you or is about to. It drops as soon as you've heard one through, and to `0` once you [clear the catch-up](#clearing-the-catch-up). A yapd from before it doesn't send it: take that as `0`.
- `updates`: the last five updates you heard, newest first, to [hear again](#hearing-an-update-again). `text` is what yapd said and `at` when the agent's turn ended. They're kept through a restart, under the same `id`s. Treat an `id` as a name. A yapd from before that forgets them when it restarts, and its ids change then.
- `recent`: the threads with the latest updates, one row each, newest first: up to eight, from the last seven days, whether or not yapd said them, so muted threads are there too. It's kept through a restart. A yapd from before it doesn't send it. See [Recent threads](#recent-threads).
- `showing`: the [card](#cards) yapd is showing, or `null`. `kind` and `title` are the card's, and `at` is when yapd put it up. Fetch the card itself from `/cards/{id}`. A yapd from before cards doesn't send it at all.
- `revision` in `showing`: the `revision` the card went up at, this time. It stays the same while the card stays up, even as the state's own moves on, and a card put back up is up anew, at a later one. Send it to [take the card down](#cards) only as it went up then. A yapd from before it doesn't send it.
- `revision`: goes up by one each time yapd puts a card up or takes one down, or is asked to take one down and doesn't, like one that's down already. It starts from `0` when yapd starts. Send it to [put a card back up](#cards) only if nothing came since. A yapd from before it doesn't send it.

The menu bar app's icon shows "not running" when it can't reach the API, "off" when `on` is false, and `activity` otherwise, with a moon while `mode` is `focus` or `quiet` and a dot while `waiting` isn't `0`. A card that's showing opens in a panel under the icon.

## Following changes

`GET /state/stream` sends the state as [server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html), one `data:` line of JSON right away and another each time it changes. Nothing is sent while nothing changes, so don't time out reads, and connect again when the connection drops, like when yapd restarts.

This prints `off`, `idle`, `speaking` or `listening` each time it changes, which is what a status bar module needs:

```sh
curl -sN http://127.0.0.1:4747/state/stream | sed -un 's/^data: //p' | jq --unbuffered -r 'if .on then .activity else "off" end'
```

A UI that shows yapd's [cards](#cards), like the menu bar app, follows `/state/stream?cards` instead. While one does, yapd takes what it puts up to be on your screen, and says so.

## Turning yapd on and off, and changing its mode

`PUT /state` with JSON changes only what it names, and returns the new state:

- `{"on": false}` or `{"on": true}` turns yapd off or on.
- `{"mode": "focus"}`, `{"mode": "quiet"}` or `{"mode": "normal"}` changes its [mode](#modes). With `"until"`, a time to come within a day, like `{"mode": "focus", "until": "2026-10-02T15:00:00.000Z"}`, focus or quiet ends then. Without it, focus lasts an hour and quiet lasts until 8:00 in the morning, yapd's time.

Both can go together, `on` first. Each stays that way when yapd restarts, and a mode whose time ran out while yapd was down is back to `normal` when it starts.

```sh
curl -X PUT -H 'Content-Type: application/json' -d '{"on": false}' http://127.0.0.1:4747/state
curl -X PUT -H 'Content-Type: application/json' -d '{"mode": "focus"}' http://127.0.0.1:4747/state
```

| Status | |
| --- | --- |
| `200` | The new state. |
| `400` | The body names neither `on` nor `mode`, or couldn't be read: `on` isn't true or false, `mode` isn't one of the three, or `until` comes without `focus` or `quiet`, isn't a time, has gone, or is more than a day off. Nothing changes then. |

Turning it off stops whatever yapd is saying at once, and drops what you asked that hasn't started yet: a dictation being recorded or transcribed, and new work still being written up or waiting on an answer. A session already being started still starts, but nothing is said about it. What was waiting to be said, being summed up or cut off is kept unheard, not dropped, and agents' hooks are let go at once, so none waits on yapd while it's off. The [card](#cards) yapd is showing comes down too, so `showing` is `null`. While it's off, its mode stays as it was, and a mode that ends meanwhile ends without a word. Turning it on again stops whatever it was saying in answer to you while it was off.

Saying "Mute." on its own, over anything yapd says or by the shortcut, turns it off the same way, and while it's off, "unmute" or "turn on" by the shortcut turns it on the same way, so the state and its stream say so. So does sending either to [`/utterances`](#asking-yapd-something), which answers `202` once it's under way.

## Modes

yapd starts each update with its headline, about fifteen words, and keeps the rest for when you say "more". What it says only to tell you how something's going, like another review round, it holds for a digest, a short catch-up said once things have been quiet for a minute, at most every twenty minutes, when three such updates are waiting or one has waited twenty minutes. "Give me everything" has yapd say every update in full and hold none of them, until "talk shorter".

Focus and quiet hold everything that doesn't need you, the same way a [muted thread](#muting-a-thread) is held: a question a thread asks, a run that failed or hit a limit, and the answer to a message you sent a thread yourself still come through. Quiet is focus until the morning, with "goodnight" for its words. Set either from here or by voice: "focus", "focus for two hours", "quiet for an hour", "goodnight", and "I'm back" to end it, which gives you the rundown of what was held. A mode that ends on its own, or from here, offers the rundown once instead. Turning yapd off is still the way to hear nothing at all.

What was held is kept like any update, unheard, so a [catch-up](#catching-up) and `recent` still have it. What came in while yapd was off isn't in the digest, nor counted in the rundown a mode offers as it ends; "I'm back" and a catch-up do tell of it. Nothing about modes or the digest ever reaches an agent.

## Catching up

yapd keeps everything it summed up, and knows which of it you heard through. Ask it to catch you up, however you put it ("catch me up", "what did I miss on Distribox?", "anything from rig since lunch?", "what did the muted ones say?"), by the shortcut or through [`/utterances`](#asking-yapd-something), and it tells you what you haven't heard: first what needs you, like a run that failed while it was off or a question in an agent's last words, then the answer to what you asked a thread and any turn it couldn't sum up, read as it was kept, options and all, four at most; then a brief of the rest, a thread at a time, in about ninety words and eight threads at most. "More" then gives you the threads it left out, or the detail of those it covered. No phrase is built into yapd for this: the model decides from what you said, as it does for anything else.

What a catch-up told you counts as heard only once you've heard it to the end; cut off, it's all still unheard. It covers the last day, or since you last turned yapd off if that's longer, up to a week; what came in while yapd was off, at any time that week, and what needs you, count for the whole week, so a short off and on since, or another night off, never drops them. Updates it cut off count only since you last spoke to it; everything it never read out counts whenever it came. Agents' questions still waiting aren't part of it: they're asked, and "who needs me?" lists them. A muted thread is left out unless you ask about it. Catching up only ever reads: nothing reaches an agent, and "tell the Distribox one to…" after it is a request like any other.

## Clearing the catch-up

`POST /catchup/clear` sets aside everything a [catch-up](#catching-up) would tell you now, exactly what `unheard` in the [state](#state) counts, without reading any of it: it counts as heard from then on, so the next catch-up doesn't tell of it and `unheard` drops to `0`, which the state stream says at once. Agents' questions still waiting aren't touched: they're still asked, and "who needs me?" still lists them. Muted threads aren't either, nor what yapd is reading you or is about to. It works while yapd is off too, since it only marks things heard, and nothing reaches an agent.

```sh
curl -X POST http://127.0.0.1:4747/catchup/clear
```

```json
{ "cleared": 53 }
```

| Status | |
| --- | --- |
| `200` | `cleared` is how many updates and notices it set aside, `0` when there was nothing to. |

A yapd from before it answers `404`.

By voice it's the model's to tell, however you put it: "clear the catch-up", "skip the catch-up", "mark everything as heard" or "I don't need the catch-up" gets "Cleared, sir: fifty-three updates set aside.", or "There's nothing to catch up on, sir." It's all of it or nothing: "I can only clear the whole catch-up, sir." Like any change, it needs your own word, so nothing faint over something yapd says clears it. "Scratch that" or "undo that" within two minutes, by voice, of either way of clearing it, brings back what it set aside that you haven't heard since: "Brought them back, sir." The [journal](#journal) has an `action` entry for each.

## Hearing an update again

`POST /updates/{id}/replay` says an update again, as it was said, without summing it up again. It goes ahead of updates that don't need you. You can reply to it like to any update, and a reply only goes to the agent if its session hasn't moved on since. One heard before yapd restarted is said again too, and a reply to it goes to its thread through T3 Code, or the way its hook was answered when it isn't tied to a thread here, which may no longer reach it: yapd says so then.

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
| `409` | yapd was turned off or on while it was being worked out, so nothing came of it. |

It works while yapd is off too, as the shortcut does: what came of it is said, and then yapd is quiet again, with no wait for a reply after it.

It can tell you what your threads are doing, who needs you, how much of your usage is left, catch you up on what you haven't heard, and say again what it just said, it can [show you things](#cards), and it can start new work, send a thread a message, now or once its current task is done, stop a thread, let it carry on, and take back a message still waiting in the queue. The same words to a thread that hasn't answered since are asked about rather than sent again. Anything else that would change a thread, like approving what it asks or archiving it, it answers with "I can't do that yet" for now. A question it asks you, like which of two threads you meant or whether to send something again, is answered by speaking over it or right after, or by asking again here. Once it's closed, however that was, asking to hear or see it again gets what it asked told rather than asked, like "I asked whether you meant the Tezos migration or the Mina tickets".

## Cards

Ask yapd to show you something, like "show me that PR", "show me what's running", "show me my usage" or "show me what I missed", which lists what you haven't heard a thread at a time, and it puts a card up and says what's on it in a line, adding "it's on your screen" only if a UI that shows cards, like the menu bar app, follows [`/state/stream?cards`](#following-changes) when the line is said. "Hide that" takes the card down, or keeps down one still to go up with what yapd hasn't said yet, but as a later step of a request, like "show me everything, then hide that", only a card that request put up. "Show me that PR" also opens the pull request in your browser. yapd only ever opens an `https` address that came from T3 Code, never one a model wrote.

When you ask about a thread that waits on something that can't be read aloud, like a command it wants to run, yapd puts that thread's card up with its answer. "Say that again" also puts a card up while a UI that shows cards follows the state: the one that went up with what it says again, anew, so it stays up while that's said, or else what it said and what it heard you say last. "Show me what you said" shows what "say that again" would say. Once yapd has been turned off and on, neither says again nor shows anything you heard before, an update or a line of yapd's own, nor puts its card back up.

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

`DELETE /cards/current` takes the card down, so `showing` becomes `null`. With `?id=`, it takes that card down only if it's still the one up, and leaves any other up, as the menu bar app does for a card it put away: a request that gets there late never takes down a card put up since. With `&shown=` too, the `revision` in `showing` as you had it, it takes the card down only if it hasn't been put up again after then, so a request that gets there late, like the menu bar app's for a card it put away just before showing it again, never takes down the same card put back up since either. A `shown` past the card's own, as the app sends once it has asked for the card back, still takes it down, so putting it away right after asking for it works. Without it, as from an app or a script from before it, it takes the card down whichever time it went up. It answers `204` either way, whether or not it took one down, and `400` when `shown` isn't a whole number.

```sh
curl -X DELETE 'http://127.0.0.1:4747/cards/current?id=cmgi3k2xa4f1&shown=6'
```

`PUT /cards/current` with one of those cards' `id` puts it back up, as the menu's Show Last Card does, so `showing` points at it again, at the `revision` it went back up at, and "hide that" takes it down. Nothing is said of it. With the [`revision`](#state) of the state you had when you asked, it does so only if the state is still at that revision, and otherwise leaves what's up as it is and answers `409`: a request that gets there late, like the menu bar app's for a card it showed again just before you closed it or yapd put another up, never undoes what came since. Without one, as from an app or a script from before revisions, it puts the card back up whatever came since.

```sh
curl -X PUT -H 'Content-Type: application/json' -d '{"id": "cmgi3k2xa4f1", "revision": 7}' http://127.0.0.1:4747/cards/current
```

| Status | |
| --- | --- |
| `204` | It's up again. |
| `400` | There's no `id`, or `revision` isn't a whole number. |
| `404` | No such card, or yapd restarted since. |
| `409` | The state has moved on from `revision`, so what's up is left as it is. |

## Threads

`GET /threads` lists the threads yapd can see, by machine, those that need you first:

```json
[
  {
    "machine": "Rosie",
    "threads": [
      {
        "id": "850299f8-3b2a-4c1d-8e7f-6a5b4c3d2e1f",
        "key": "t3:Rosie:850299f8-3b2a-4c1d-8e7f-6a5b4c3d2e1f",
        "project": "integration",
        "title": "Migrate the Tezos integration",
        "state": "running",
        "since": "2026-10-02T13:40:00.000Z",
        "muted": false,
        "subagents": false,
        "pr": { "number": 412, "url": "https://github.com/lg-epitech/integration/pull/412", "state": "open", "checks": "passing" }
      }
    ]
  },
  { "machine": "rig", "reason": "I can't see rig's threads yet.", "threads": [] }
]
```

- `reason`: why a machine's threads can't be seen right now, like T3 Code not running. Its `threads` are empty then.
- `key`: the thread's key, to [mute](#muting-a-thread) it by, and `muted` whether it is. A yapd from before mutes sends neither.
- `subagents`: whether its [subagents are read](#hearing-a-threads-subagents) to you. A yapd from before it doesn't send it: take that as `false`.
- `state`: `approval` or `question` when the thread waits on you, `running`, `finishing`, `queued`, `failed`, `limited` when it hit a usage limit, or `idle`. `since` is when it got there.
- `pr`: its latest pull request, when it has one. `url` is only ever `https`, and missing when the address T3 Code has for it isn't. `state`, `checks`, `review` and `mergeability` are there when T3 Code knows them.

Archived threads and the ones a thread runs for itself aren't listed. Nothing here changes a thread: ask yapd through [`/utterances`](#asking-yapd-something), so the same rules apply as when you speak. Muting one only changes what yapd says.

## Recent threads

Each row of `recent` in the [state](#state) is a thread, by its newest update or notice, which is how a menu lists what's been going on:

- `key`: the thread's key, the same as in [`/threads`](#threads), to [see more of it](#thread-details), [mute](#muting-a-thread) it or [hear it again](#hearing-a-thread-again) by. Treat it as a name, not something to take apart. A session yapd can't tie to a T3 Code thread, like one run in a terminal, has a key of its own.
- `machine`: where it runs. `thread`: its id in T3 Code, as [`/threads`](#threads) has it, or `null` for a session yapd can't tie to one.
- `title`: the thread's title in T3 Code, or for a session, "Claude session" or "Codex session", with "on rig" after it when it's not this machine. While yapd can't see a thread in T3 Code, as for a few seconds after it starts or while another machine can't be reached, it's what yapd calls the thread when it's muted, else "A thread", and the thread has no `project` `id` or `icon` until it's seen again.
- `project`: there when yapd knows the project. `name` is how it's called, and `id` and `icon` are there only for a project T3 Code has.
- `text`: what yapd said of its latest update, or would have, had it not been muted. `at`: when the agent's turn ended.
- `muted`: whether it's muted, and `until`, when the mute ends on its own, only then.
- `waiting`: whether the thread waits on you, for an approval or an answer.
- `replayable`: whether it can be [heard again](#hearing-a-thread-again). It's `true` while its latest update is one of the `updates` you heard, and otherwise only for a thread yapd can reach: one T3 Code has, not archived, on a machine whose threads yapd can see now. A session's row, or an archived or deleted thread, or one on a machine that's away, is `false` once its update is no longer among the `updates`. It can lag a minute behind, as when a thread is archived; hearing it again checks then. A yapd from before it doesn't send it: take that as `true`.
- `unheard`: how many of the thread's updates and notices you haven't heard, from every session of it, that a [catch-up](#catching-up) would tell you of, muted or not. What was kept under another session of it, like one whose link to the thread timed out, is told in a catch-up of everything rather than in one about the thread alone. A menu shows it beside a thread that isn't muted. It drops as soon as you've heard them through. A yapd from before it doesn't send it: take that as `0`.
- `subagents`: on every T3 Code thread's row, whether its [subagents are read](#hearing-a-threads-subagents) to you; on a subagent's row, whether those of the thread it's part of are. Never on a session's row. A yapd from before it doesn't send it.
- `head`: only on a subagent's row, the thread it's part of, by its `key` and `title`, which its `subagents` is about and turning them on or off goes by.

A thread's subagents that are read to you take one row between them, the newest, titled as T3 Code titles that subagent, like "Sol review: release blockers". It's `muted` when it or the thread it's part of is, and `replayable` only while its update is one of the `updates` you heard. Subagents kept to yapd, as every thread's are until you have them read, take no row.

`icon` is how T3 Code draws the project, as one of these `kind`s:

- `image`: the project's own icon. Fetch it from `url`, a path on this API, and keep it by `revision`, which only changes with the image.
- `emoji`: the `emoji` to draw.
- `monogram`: the two letters in `text`, in `color`.

Every icon carries `text` and `color` too, the monogram to draw for a kind you don't know, or an image you can't read. `color` is one of `gray`, `red`, `orange`, `amber`, `yellow`, `lime`, `green`, `emerald`, `teal`, `cyan`, `sky`, `blue`, `indigo`, `violet`, `purple`, `fuchsia`, `pink` and `rose`, as T3 Code has them.

`GET /projects/{machine}/{project}/icon` returns the image itself, by the machine and the project's `id`, with T3 Code's `Content-Type` and an `ETag` of its `revision`. It answers `304` when you send that back in `If-None-Match`, and `404` when the project has no image, or none yapd has fetched yet. yapd fetches it from T3 Code itself, so you never need T3 Code's address or a link that would expire.

## Thread details

`GET /threads/{key}` tells more of a thread, by its `key` from `recent`, percent-encoded, as a panel beside its row in a menu shows it:

```json
{
  "key": "t3:Rosie:850299f8-3b2a-4c1d-8e7f-6a5b4c3d2e1f",
  "machine": "Rosie",
  "thread": "850299f8-3b2a-4c1d-8e7f-6a5b4c3d2e1f",
  "state": "running",
  "since": "2026-10-02T13:40:00.000Z",
  "branch": "t3/migrate-tezos",
  "pr": { "number": 412, "url": "https://github.com/lg-epitech/integration/pull/412", "state": "open", "checks": "passing" },
  "muted": true,
  "until": "2026-10-02T15:00:00.000Z",
  "updates": [
    { "id": 1872, "at": "2026-10-02T14:01:40.000Z", "kind": "update", "said": "integration. The migration is done and the tests pass. Two fixtures needed TzKT's rounding.", "unsaid": "muted", "unheard": true },
    { "id": 1860, "at": "2026-10-02T13:52:05.000Z", "kind": "sent", "text": "Use TzKT's rounding." },
    { "id": 1851, "at": "2026-10-02T13:50:12.000Z", "kind": "notice", "said": "The Tezos migration asks which rounding to use.", "heard": "2026-10-02T13:50:20.000Z" }
  ]
}
```

- `machine` and `thread`: as in `recent`.
- `state`, `since`, `branch` and `pr`: what it's doing and since when, the branch it works on and its latest pull request, as [`/threads`](#threads) has them. They're there only for a thread T3 Code has that yapd can see now, and `branch` and `pr` only when it has them.
- `muted` and `until`: as in `recent`, and so are `subagents` and `head`.
- `updates`: its latest five updates and notices, heard or not, and messages yapd passed on to it for you, newest first, from every session of it. `said` is all of what yapd said or kept of an update or notice, what it keeps for "more" too, and a message has only `text`, the words it passed on. `heard` and `unsaid` are as the [journal](#journal) has them. `unheard` is `true` only for one you haven't heard that a [catch-up](#catching-up) would tell you of, the ones `unheard` in `recent` counts: one you never heard through but a catch-up no longer tells of, like an update cut off before you last spoke, has neither `heard` nor `unheard`.

It only reads: nothing reaches the thread, and nothing counts as heard.

| Status | |
| --- | --- |
| `200` | What yapd knows of it. |
| `400` | The key isn't one yapd makes. |
| `404` | No thread yapd knows, as for [muting](#muting-a-thread) one. A yapd from before it answers this for every key. |

## Muting a thread

Some threads are noisy. Muting one stops yapd saying its progress and what it finished, but anything that needs you still comes through: a question it asks, an approval it waits on, a run that failed or hit a limit, and the answer to a message you sent it yourself. What's muted is still kept, unheard, and `recent` still shows it, but a [catch-up](#catching-up) leaves it out unless you ask about that thread by name, or about what your muted threads said.

`PUT /threads/{key}/mute` mutes the thread by its `key`, percent-encoded, and drops what of it was waiting to be said, but never what's being said. With `{"until": "2026-10-02T15:00:00.000Z"}` as JSON, the mute ends on its own then. Without a body, it lasts until you take it off. `DELETE /threads/{key}/mute` takes it off, whether it was muted or not, along with the mute of the session its latest update came from, which `recent` shows as the thread's.

```sh
curl -X PUT 'http://127.0.0.1:4747/threads/t3%3ARosie%3A850299f8-3b2a-4c1d-8e7f-6a5b4c3d2e1f/mute'
```

| Status | |
| --- | --- |
| `204` | It's muted, or no longer muted, also when it wasn't muted. |
| `400` | The key isn't one yapd makes, muting or taking a mute off, or, muting, the body couldn't be read or `until` isn't a time to come. |
| `404` | Muting, no thread yapd knows: not in `recent`, not one T3 Code has, as [`/threads`](#threads) lists them and those it archived, and not muted already. |

You can mute by voice too: "mute it", "mute that for an hour", "unmute it", "what's muted?" and "unmute everything". "Scratch that" takes back a mute you just made. Muting never sends anything to the thread.

A subagent's row mutes that subagent only, like any thread, and muting the thread it's part of mutes it too.

## Hearing a thread's subagents

The reviews and other work T3 Code runs for a thread as its subagents are kept to yapd by default: summed up and kept, as a muted thread's are, but never said, never counted as unheard, and left out of `recent` and of a catch-up unless you ask what that thread's subagents said. Whatever one says is kept so, even what would need you. The thread's own turns, like the one where it takes in a subagent's result, are said as ever. Subagents a provider runs inside its thread's own session, like Claude's Agent tool, never reach yapd.

`PUT /threads/{key}/subagents` has a thread's subagents read to you from now on, by its `key`, percent-encoded, whether it has any yet or not; each is then said led by the thread, like "For the Tezos migration: one release blocker is left." It lasts until you take it off, never for a set time. `DELETE /threads/{key}/subagents` keeps them to yapd again, and drops what of them was waiting to be said, whatever it is, but never what's being said. Neither sends anything to a thread.

| Status | |
| --- | --- |
| `204` | They're read, or no longer, also when nothing changed. |
| `400` | The key isn't a T3 Code thread's, like a session's. |
| `404` | No thread yapd knows, as for [muting](#muting-a-thread) one, and not one whose subagents are read already. |
| `409` | It's a subagent's own key: its subagents are read by the thread it's part of. |

By voice: "read me its subagents" and "stop reading its subagents" over an update, or "read me the Tezos migration's subagents" with the shortcut, and "what did its subagents say?" to hear what they kept. "What's muted?" ends with whose subagents are read.

## Hearing a thread again

`POST /threads/{key}/replay` says the thread's latest update again, by its `key` from `recent`, even a muted one. When that latest update is one of the `updates` you heard, it's said as [hearing an update again](#hearing-an-update-again) says it, so a reply to it still gets there. Otherwise, for a thread yapd can reach, it says what it kept of it, and "it" then means that thread, and counts it as heard once it's said to the end, so a digest or a catch-up doesn't tell you of it again. That includes an update kept while yapd was off. Anything else, a session's row or a thread yapd can't reach (archived, deleted, or on a machine that's away), isn't said again: it's `replayable: false` in `recent`, and this answers `409` and plays nothing.

| Status | |
| --- | --- |
| `202` | It's been queued. |
| `404` | Nothing to say of it. |
| `409` | yapd is off, or it can't be heard again: a session's row, or a thread yapd can't reach, whose update is no longer among the `updates`. The body says which. |

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

- `kind`: `update` for an agent's turn yapd summed up, whether it said it, the thread was muted, or yapd held it for later, `reply` for what you said back to one, `dictation` for what you dictated or typed, `answer` for what yapd answered, `started` for work it started, `sent` for a message it passed on, `notice` for something it brought up itself, `brief` for a digest of what it held for later, and `action` for anything else it did, like turning off, muting a thread or changing its mode.
- `said` is what yapd said, `text` the words it was about, like what you said or an agent's message, and `heard` when you heard it through.
- `unsaid`: for an update yapd didn't read out, why: `subagent` for one of a thread's subagents' kept to yapd, `muted`, `focus`, `quiet`, `progress` for one held for the digest, or `off` for one that came in while yapd was off. Missing when it was read out. With `heard`, it tells an update read out in full (`heard`, no `unsaid`), cut off (neither), told of later in a catch-up, a digest or from the menu (both), or still missed (`unsaid`, no `heard`). One you [cleared](#clearing-the-catch-up) has `heard` as of when you did.
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
