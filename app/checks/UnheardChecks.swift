import Foundation

/// The menu reads how much he hasn't heard from any yapd, old or new, says it beside a thread that isn't muted, offers "Catch Me
/// Up (N)" only while there's something, asks for it as he'd say it, and asks yapd anything while it's off only when it answers then.
@MainActor func checkUnheard() {
  let decoded = { (json: String) in try? JSONDecoder().decode(Status.self, from: Data(json.utf8)) }
  let row = { (key: String, fields: String) in
    #"{"key": "\#(key)", "machine": "Rosie", "thread": "850299f8", "title": "Distribox migration", "text": "distribox. The migration is done.", "at": "2026-10-02T14:01:40.000Z", "waiting": false\#(fields)}"#
  }

  // A yapd with them: the total, and each thread's own, muted or not.
  let new = decoded(#"{"on": false, "activity": "idle", "waiting": 1, "unheard": 6, "recent": [\#(row("t3:Rosie:850299f8", #", "muted": false, "replayable": true, "unheard": 2"#)), \#(row("t3:Rosie:2", #", "muted": true, "unheard": 12"#))]}"#)
  check(new?.unheard == 6, "reads how much he hasn't heard, not \(String(describing: new?.unheard))")
  check(new?.recent?.map(\.unheard) == [2, 12], "reads how much of each thread he hasn't heard, muted or not, not \(String(describing: new?.recent?.map(\.unheard)))")
  check(new?.unheardLine == "Catch Me Up (6)", "offers to catch him up on what he hasn't heard, not \(String(describing: new?.unheardLine))")

  // A yapd from before them: nothing unheard, nothing offered, and nothing asked of it while it's off, which it turns away.
  let old = decoded(#"{"on": false, "activity": "idle", "waiting": 2, "recent": [\#(row("t3:Rosie:850299f8", #", "muted": false"#))]}"#)
  check(old != nil && old?.unheard == 0 && old?.recent?.first?.unheard == 0, "reads a yapd from before them as one with nothing unheard")
  check(old?.unheardLine == nil, "offers no catch-up from a yapd from before it")
  check(old?.answers == false, "asks nothing of a yapd from before it while it's off")
  check(decoded(#"{"on": true, "activity": "idle"}"#)?.answers == true, "asks a yapd from before it while it's on")

  // What it can't read of them leaves the rest, as a yapd from before them, and never counts fewer than none.
  let odd = decoded(#"{"on": true, "activity": "idle", "waiting": 1, "unheard": "six", "recent": [\#(row("t3:Rosie:850299f8", #", "unheard": "two""#)), \#(row("t3:Rosie:2", #", "unheard": -4"#))]}"#)
  check(odd?.unheard == 0 && odd?.waiting == 1, "reads a state whose unheard it can't read")
  check(odd?.recent?.map(\.unheard) == [0, 0], "reads rows whose unheard it can't read, or is below none, as none, not \(String(describing: odd?.recent?.map(\.unheard)))")
  check(decoded(#"{"on": true, "activity": "idle", "unheard": -2}"#)?.unheard == 0, "never counts fewer than none unheard")
  check(Status.Recent(key: "k", machine: "Rosie", title: "t", text: "Done.", at: "2026-10-02T14:01:40Z", unheard: -1).unheard == 0, "never makes a row with fewer than none unheard")

  // Nothing unheard offers nothing; one is offered as one.
  check(decoded(#"{"on": true, "activity": "idle", "unheard": 0}"#)?.unheardLine == nil, "offers no catch-up when he's heard everything")
  check(decoded(#"{"on": true, "activity": "idle", "unheard": 1}"#)?.unheardLine == "Catch Me Up (1)", "offers to catch him up on one")

  // While it's off, a yapd that counts what's unheard still answers, as the shortcut does, so the menu asks it.
  check(new?.on == false && new?.answers == true, "asks a yapd that answers while it's off even while it's off")
  check(decoded(#"{"on": false, "activity": "idle", "unheard": 0}"#)?.answers == true, "asks a yapd that answers while it's off, with nothing unheard")

  // Beside a thread: how many he hasn't heard, unless it's muted, which says so instead.
  let now = Date(timeIntervalSince1970: 1_790_949_700 + 180)
  let rows = new?.recent ?? []
  check(rows.first?.detail(now: now) == "3 min ago · 2 unheard", "says how many of a thread he hasn't heard, not \(String(describing: rows.first?.detail(now: now)))")
  check(rows.last?.detail(now: now) == "3 min ago · muted", "says nothing unheard beside a muted thread, not \(String(describing: rows.last?.detail(now: now)))")
  let waiting = Status.Recent(key: "k", machine: "Rosie", title: "t", text: "Done.", at: "2026-10-02T14:01:40Z", waiting: true, unheard: 3)
  check(waiting.detail(now: now) == "3 min ago · waiting on you · 3 unheard", "says a thread waits on him before how much he hasn't heard, not \(waiting.detail(now: now))")
  check(old?.recent?.first?.detail(now: now) == "3 min ago", "says nothing unheard of a row from a yapd from before it")

  // A thread kept while yapd was off is heard again as any other: while yapd is on, if yapd can say it again.
  if let kept = rows.first {
    check(kept.hearable(on: true) && !kept.hearable(on: false), "hears again a thread with updates kept unheard only while yapd is on")
    let replaying = Replaying(kept)
    check(replaying.method == "POST" && replaying.url(at: URL(string: "http://127.0.0.1:4747")!)?.absoluteString == "http://127.0.0.1:4747/threads/t3%3ARosie%3A850299f8/replay", "hears a thread with updates kept unheard again by its key")
  } else {
    check(false, "reads a thread with updates kept unheard")
  }

  // What the menu sends: his words, as he'd say them, so yapd's model decides what catching him up means.
  let asked = (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(Utterance.catchMeUp))) as? [String: String]
  check(asked == ["text": "catch me up"], "asks to be caught up as he'd say it, not \(String(describing: asked))")
}
