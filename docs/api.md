# API

yapd serves a small HTTP API on the port its hooks use, `127.0.0.1:4747` unless `YAPD_PORT` says otherwise. The [menu bar app](../README.md#menu-bar) only uses this API, so your own UI can do everything it does: a status bar module on Linux, a Stream Deck button, a script.

It only listens on localhost. From another machine, forward the port over SSH, like `ssh -N -L 4747:127.0.0.1:4747 mac`. A machine whose hooks already reach yapd through a [reverse tunnel](../README.md#agents-on-another-machine) can use the API at the same address.

There's no authentication: anything that can reach the port can use it, as hooks do. Requests have to be addressed to `127.0.0.1`, `localhost` or `[::1]`, so a web page can't get in through a domain name of its own that points here, and a page from anywhere else can't read the responses, since yapd sends no CORS headers.

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
  ]
}
```

- `on`: whether yapd is on. While it's off, it says nothing, never opens the microphone and lets go of the dictation shortcut. Updates that finish meanwhile are never said, not even later.
- `activity`: `speaking` while yapd plays something, `listening` while the microphone is open without it, for a reply after an update or while you dictate, and `idle` otherwise.
- `updates`: the last five updates yapd said, newest first, to [hear again](#hearing-an-update-again). `text` is what it said and `at` when the agent's turn ended. They're forgotten when yapd restarts.

The menu bar app's icon shows "not running" when it can't reach the API, "off" when `on` is false, and `activity` otherwise.

## Following changes

`GET /state/stream` sends the state as [server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html), one `data:` line of JSON right away and another each time it changes. Nothing is sent while nothing changes, so don't time out reads, and connect again when the connection drops, like when yapd restarts.

This prints `off`, `idle`, `speaking` or `listening` each time it changes, which is what a status bar module needs:

```sh
curl -sN http://127.0.0.1:4747/state/stream | sed -un 's/^data: //p' | jq --unbuffered -r 'if .on then .activity else "off" end'
```

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

`POST /utterances` with `{"text": "who needs me?"}` as JSON takes what you typed as if you'd said it by the shortcut: yapd works out what you meant, does it, and says what came of it ahead of anything else. It answers once that's worked out, which can take the model a few seconds, with the request's id, the same one its log lines carry.

```sh
curl -X POST -H 'Content-Type: application/json' -d '{"text": "what is going on?"}' http://127.0.0.1:4747/utterances
```

| Status | |
| --- | --- |
| `202` | `{"id": "u…"}`: it's been worked out, and what came of it is waiting to be said. |
| `400` | There's no text. |
| `409` | yapd is off. |

It can tell you what your threads are doing, who needs you, how much of your usage is left, what you missed, and say again what it just said, and it can start new work. Anything that would change a thread, like sending it a message or stopping it, it answers with "I can't do that yet" for now. A question it asks you, like which of two threads you meant, is answered by speaking over it or right after, or by asking again here.

## Errors

Besides those, `400` means the body couldn't be read, `403` that the request was addressed to another host, and `500` that something went wrong in yapd, which its log says more about. `GET /health` answers `ok` while yapd runs.

`POST /events` is for the hooks, and isn't part of this API.
