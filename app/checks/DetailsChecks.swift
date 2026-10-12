import Foundation

/// A row's panel reads what yapd tells of its thread from any yapd, old or new, asks for it and mutes a thread for an hour by its
/// key, and its card says what the thread is doing, its pull request, whether it's muted, and the latest told of it, from what
/// the row has until yapd's details come, and when they never do.
@MainActor func checkDetails() {
  let api = URL(string: "http://127.0.0.1:4747")!
  let ok = { (status: Int) in HTTPURLResponse(url: api, statusCode: status, httpVersion: nil, headerFields: nil)! }
  let documented = #"""
    {
      "key": "t3:Rosie:850299f8", "machine": "Rosie", "thread": "850299f8", "state": "running", "since": "2026-10-02T13:40:00.000Z",
      "branch": "t3/migrate-tezos",
      "pr": { "number": 412, "url": "https://github.com/lg-epitech/integration/pull/412", "state": "open", "checks": "passing", "review": "approved" },
      "muted": true, "until": "2026-10-02T15:00:00.000Z",
      "updates": [
        { "id": 1872, "at": "2026-10-02T14:01:40.000Z", "kind": "update", "said": "integration. The migration is done and the tests pass.", "unsaid": "muted", "unheard": true },
        { "id": 1860, "at": "2026-10-02T13:52:05.000Z", "kind": "sent", "text": "Use TzKT's rounding." },
        { "id": 1851, "at": "2026-10-02T13:50:12.000Z", "kind": "notice", "said": "The Tezos migration asks which rounding to use.", "heard": "2026-10-02T13:50:20.000Z" }
      ]
    }
    """#
  let details = Details(Data(documented.utf8), ok(200))
  check(details?.key == "t3:Rosie:850299f8" && details?.machine == "Rosie" && details?.thread == "850299f8", "reads a thread's key, machine and id")
  check(details?.state == "running" && details?.since == "2026-10-02T13:40:00.000Z" && details?.branch == "t3/migrate-tezos", "reads what a thread is doing, since when, and its branch")
  check(details?.pr == Details.PullRequest(number: 412, url: "https://github.com/lg-epitech/integration/pull/412", state: "open", checks: "passing", review: "approved"), "reads its pull request, not \(String(describing: details?.pr))")
  check(details?.muted == true && details?.until == "2026-10-02T15:00:00.000Z", "reads whether it's muted, and until when")
  check(details?.updates.map(\.id) == [1872, 1860, 1851] && details?.updates.map(\.kind) == [.update, .sent, .notice], "reads its updates, notices and what he sent it, in order")
  check(details?.updates[1].text == "Use TzKT's rounding." && details?.updates[2].heard == "2026-10-02T13:50:20.000Z", "reads what he sent, and when he heard one")
  check(details?.updates.map(\.unheard) == [true, false, false], "reads which he hasn't heard, as the row counts them")

  // Only what yapd answers with them is read: not what it doesn't know, as a yapd from before them says of every thread.
  for status in [400, 404, 500] {
    check(Details(Data(documented.utf8), ok(status)) == nil, "reads nothing of a \(status)")
  }
  check(Details(Data("not json".utf8), ok(200)) == nil, "reads nothing of an answer it can't read")

  // What it can't read of them leaves the rest.
  let odd = Details(Data(#"""
    {"key": "session:rig:claude:abc", "machine": "rig", "thread": null, "pr": {"url": "https://x"}, "muted": "yes", "updates": [
      {"id": 1, "at": "2026-10-02T14:01:40Z", "kind": "update", "said": "Done.", "unheard": "yes"}, {"id": 2, "at": "2026-10-02T14:00:00Z", "kind": "action"}, {"id": "3"}
    ]}
    """#.utf8), ok(200))
  check(odd?.thread == nil && odd?.state == nil && odd?.pr == nil && odd?.muted == false, "reads a session's details whose pull request and mute it can't read, with none")
  check(odd?.updates.map(\.id) == [1], "leaves out only what it can't read of its updates, not \(String(describing: odd?.updates.map(\.id)))")
  check(odd?.updates.first?.unheard == false, "takes one whose unheard it can't read as not unheard")
  check(Details(Data(#"{"key": "k", "machine": "Rosie", "muted": false}"#.utf8), ok(200))?.updates == [], "reads details with no updates")

  // Asked for by the thread's key, encoded whole, and only read; and its pull request opened only at an https address.
  let row = Status.Recent(
    key: "t3:Rosie:850299f8", machine: "Rosie", thread: "850299f8", title: "Migrate the Tezos integration",
    project: Status.Recent.Project(name: "integration"), text: "integration. The migration is done.", at: "2026-10-02T14:01:40.000Z", unheard: 2
  )
  let detailing = Detailing(row)
  check(detailing.method == "GET" && detailing.body == nil && detailing.url(at: api)?.absoluteString == "http://127.0.0.1:4747/threads/t3%3ARosie%3A850299f8", "asks for a thread's details by GET to its key, not \(String(describing: detailing.url(at: api)))")
  check(details?.pr?.address == URL(string: "https://github.com/lg-epitech/integration/pull/412"), "opens a pull request at its https address")
  for url in ["http://github.com/lg-epitech/integration/pull/412", "file:///etc/passwd", "javascript:alert(1)", ""] {
    check(Details.PullRequest(number: 1, url: url).address == nil, "never opens a pull request at \(url.debugDescription)")
  }

  // Muting for an hour says when it ends, in ISO 8601, as yapd reads it; muting until he takes it off, and taking it off, send nothing.
  let now = Date(timeIntervalSince1970: 1_790_949_700 + 180)
  let hour = Muting.forAnHour(row, from: now)
  let body = hour.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }
  check(hour.method == "PUT" && hour.url(at: api)?.absoluteString == "http://127.0.0.1:4747/threads/t3%3ARosie%3A850299f8/mute", "mutes for an hour by PUT to its key")
  check(body == ["until": "2026-10-02T15:04:40.000Z"], "mutes for an hour from now, not \(String(describing: body))")
  check(body.flatMap { $0["until"] }.flatMap(Status.date) == now.addingTimeInterval(3600), "says when the mute ends as a time yapd reads")
  check(Muting(row, on: true).body == nil && Muting(row, on: false).body == nil && Muting(row, on: false, until: now).body == nil, "sends no time with a mute that lasts, nor to take one off")

  // The card from the row alone, as when yapd doesn't know the thread, or is too old to tell.
  let utc = TimeZone(identifier: "UTC")!
  let english = Locale(identifier: "en_US")
  let plain = { (line: String?) in line?.replacingOccurrences(of: "\u{202F}", with: " ") }
  let alone = Glance(row, details: nil, now: now, zone: utc, locale: english)
  check(alone.title == "Migrate the Tezos integration" && alone.place == "integration · Rosie", "names the thread, its project and its machine, not \(alone.place)")
  check(alone.doing == nil && alone.branch == nil && alone.pr == nil && alone.muted == nil && alone.unheard == "2 unheard", "shows only what the row has, not \(alone)")
  check(alone.latest?.text == "integration. The migration is done." && alone.heard == "3 min ago" && alone.earlier.isEmpty, "shows the row's latest update, with nothing on whether he heard it, not \(String(describing: alone.heard))")
  let session = Status.Recent(key: "session:rig:claude:abc", machine: "rig", title: "Claude session on rig", text: "", at: "soon")
  let empty = Glance(session, details: nil, now: now)
  check(empty.place == "rig" && empty.latest == nil && empty.heard == nil, "shows a session with no project and nothing said of it")

  // With yapd's details: all of it.
  let muted = Status.Recent(key: row.key, machine: "Rosie", thread: "850299f8", title: row.title, project: row.project, text: row.text, at: row.at, muted: true, until: "2026-10-02T15:00:00.000Z", unheard: 2)
  guard let details else { return check(false, "reads a thread's details") }
  let full = Glance(muted, details: details, now: now, zone: utc, locale: english)
  check(full.doing == Glance.Doing(line: "Running · 24 min", tone: .busy), "says what it's doing and for how long, not \(String(describing: full.doing))")
  check(full.branch == "t3/migrate-tezos" && full.pr == "#412 · open · checks passing · approved", "says its branch and its pull request, not \(String(describing: full.pr))")
  check(plain(full.muted) == "Muted until 3:00 PM" && full.unheard == nil, "says until when it's muted, and nothing unheard while it is, not \(String(describing: full.muted))")
  check(full.latest?.text == "integration. The migration is done and the tests pass." && full.heard == "3 min ago · unheard", "shows all of its latest update and that he hasn't heard it, not \(String(describing: full.heard))")
  check(full.earlier.map(\.text) == ["You: Use TzKT's rounding.", "The Tezos migration asks which rounding to use."], "shows what came before, what he sent too, not \(full.earlier.map(\.text))")
  check(full.earlier.map(\.when) == ["12 min ago", "14 min ago"] && full.earlier.map(\.unheard) == [false, false], "tells when each came, and marks none he heard or sent")
  let until = { (until: String) in plain(Glance(Status.Recent(key: "k", machine: "Rosie", title: "t", text: "Done.", at: row.at, muted: true, until: until), details: nil, now: now, zone: utc, locale: english).muted) }
  check(until("2026-10-03T09:00:00Z") == "Muted until 9:00 AM tomorrow", "says a mute ends tomorrow")
  // Muted on a Friday until a day after, as he can by voice, its weekday in the week ahead, its date after that.
  for (end, said) in [("2026-10-06T09:00:00Z", "Muted until Tue 9:00 AM"), ("2026-10-08T09:00:00Z", "Muted until Thu 9:00 AM"), ("2026-10-09T09:00:00Z", "Muted until Oct 9 at 9:00 AM")] {
    check(until(end) == said, "says \(said), not \(String(describing: until(end)))")
  }
  check(Glance(Status.Recent(key: "k", machine: "Rosie", title: "t", text: "Done.", at: row.at, muted: true), details: nil, now: now).muted == "Muted", "says a mute with no end is on")

  // The latest is the newest update or notice, what he sent since under it, and the rest, at most four, under Earlier, all from before
  // it; what says nothing is left out. Each heard through, unheard as the row counts it, or neither, as one cut off before he spoke.
  let told = { (id: Int, minutes: Double, kind: Details.Told.Kind, words: String?, heard: Bool?) in
    Details.Told(
      id: id, at: ISO8601DateFormatter().string(from: now.addingTimeInterval(-minutes * 60)), kind: kind, said: kind == .sent ? nil : words, text: kind == .sent ? words : nil,
      heard: heard == true ? "2026-10-02T14:00:00Z" : nil, unheard: heard == false
    )
  }
  let many = Details(key: row.key, machine: "Rosie", updates: [
    told(10, 0.5, .sent, "Ship it.", nil), told(9, 1, .sent, "Then merge it.", nil), told(8, 2, .notice, "It asks to ship.", true), told(7, 3, .update, "", false),
    told(6, 4, .update, "Four.", false), told(5, 5, .update, "Five.", true), told(4, 6, .sent, "Six.", nil), told(3, 7, .update, "Seven.", nil), told(2, 8, .update, "Eight.", false),
  ])
  let latest = Glance(row, details: many, now: now)
  check(latest.latest?.text == "It asks to ship." && latest.heard == "2 min ago · heard", "shows the newest update or notice as the latest, not \(String(describing: latest.latest?.text))")
  check(latest.replies.map(\.text) == ["You: Then merge it.", "You: Ship it."] && latest.replies.map(\.when) == ["1 min ago", "now"], "shows what he sent since under the latest, oldest first, not \(latest.replies.map(\.text))")
  check(latest.earlier.map(\.text) == ["Four.", "Five.", "You: Six.", "Seven."], "shows at most four from before it, newest first, none that says nothing, not \(latest.earlier.map(\.text))")
  check(latest.earlier.map(\.unheard) == [true, false, false, nil], "marks only the updates he hasn't heard as the row counts them, not \(latest.earlier.map(\.unheard))")
  let cut = Glance(row, details: Details(key: row.key, machine: "Rosie", updates: [told(1, 2, .update, "Cut off.", nil)]), now: now)
  check(cut.latest?.text == "Cut off." && cut.heard == "2 min ago", "says neither heard nor unheard of one a catch-up no longer tells of, not \(String(describing: cut.heard))")
  let sentOnly = Glance(row, details: Details(key: row.key, machine: "Rosie", updates: [told(2, 1, .sent, "Hi.", nil), told(1, 10, .sent, "Before.", nil)]), now: now)
  check(sentOnly.latest?.text == row.text && sentOnly.replies.map(\.text) == ["You: Hi."] && sentOnly.earlier.map(\.text) == ["You: Before."], "shows the row's latest update when yapd has only what he sent, what he sent since under it, not \(sentOnly.replies.map(\.text)) and \(sentOnly.earlier.map(\.text))")
  check(alone.replies.isEmpty && full.replies.isEmpty, "shows nothing under the latest when he sent nothing since")

  // Waiting on him, the row says so until yapd tells more, or when it can't; what yapd tells of it comes first.
  let waiting = Status.Recent(key: row.key, machine: "Rosie", thread: "850299f8", title: row.title, project: row.project, text: row.text, at: row.at, waiting: true)
  check(Glance(waiting, details: nil, now: now).doing == Glance.Doing(line: "Waiting on you", tone: .waiting), "says a thread waits on him from its row alone")
  check(Glance(waiting, details: Details(key: row.key, machine: "Rosie"), now: now).doing == Glance.Doing(line: "Waiting on you", tone: .waiting), "says so when yapd can't see what it's doing")
  check(Glance(waiting, details: Details(key: row.key, machine: "Rosie", state: "question"), now: now).doing == Glance.Doing(line: "Waiting on you · a question", tone: .waiting), "says what it waits on when yapd tells")
  check(alone.doing == nil, "says nothing of what a thread is doing from a row that doesn't wait")

  // What a thread is doing, in a few words, with a colour.
  let start = now.addingTimeInterval(-(2 * 3600 + 5 * 60))
  let doings: [(String, Date?, String, Glance.Tone)] = [
    ("running", start, "Running · 2 h 5 min", .busy), ("running", now.addingTimeInterval(-20), "Running · under a minute", .busy),
    ("running", now.addingTimeInterval(-3 * 3600), "Running · 3 h", .busy), ("running", nil, "Running", .busy),
    ("running", now.addingTimeInterval(-3 * 86400), "Running · 3 days", .busy),
    ("approval", start, "Waiting on you · an approval", .waiting), ("question", start, "Waiting on you · a question", .waiting),
    ("finishing", start, "Finishing", .busy), ("queued", start, "Queued", .still), ("failed", start, "Failed", .failed),
    ("limited", start, "Hit a usage limit", .limited), ("idle", now.addingTimeInterval(-3 * 3600), "Idle · since 3 h ago", .still),
    ("idle", now.addingTimeInterval(-10), "Idle · just now", .still), ("idle", nil, "Idle", .still), ("paused-for_review", start, "Paused for review", .still),
  ]
  for (state, since, line, tone) in doings {
    let doing = Glance.doing(state, since: since, now: now)
    check(doing == Glance.Doing(line: line, tone: tone), "says \(line) for \(state), not \(doing)")
  }

  // A pull request in a line, as T3 Code words it.
  let prs: [(Details.PullRequest, String)] = [
    (Details.PullRequest(number: 412, state: "open", checks: "failing", review: "changes-requested", mergeability: "conflicting"), "#412 · open · checks failing · changes requested · conflicts"),
    (Details.PullRequest(number: 412, state: "open", checks: "pending", review: "review-required", mergeability: "mergeable"), "#412 · open · checks pending · waiting for a review"),
    (Details.PullRequest(number: 7, state: "merged", mergeability: "conflicting"), "#7 · merged"),
    (Details.PullRequest(number: 7), "#7"),
  ]
  for (pr, line) in prs {
    check(Glance.pr(pr) == line, "says \(line), not \(Glance.pr(pr))")
  }
}
