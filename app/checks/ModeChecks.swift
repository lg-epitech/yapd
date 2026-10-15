import Foundation

/// The menu reads the mode, when it ends and how many threads wait on him from any yapd, old or new, shows the moon and the dot
/// as they say, and has yapd change its mode with a `PUT /state` that names only the mode.
@MainActor func checkMode() {
  let decoded = { (json: String) in try? JSONDecoder().decode(Status.self, from: Data(json.utf8)) }

  // A yapd from before modes: as normal, with nothing waiting, which the menu can't ask to change its mode.
  let old = decoded(#"{"on": true, "activity": "idle", "updates": []}"#)
  check(old != nil && old?.mode == nil && old?.until == nil && old?.waiting == 0, "reads a yapd from before modes as one with none and nothing waiting")
  check(old?.change(to: .focus) == nil && old?.change(to: .normal) == nil, "never asks a yapd from before modes to change its mode")
  check(old?.modeLine(now: Date()) == nil && old?.waitingLine == nil, "says nothing of a mode or of threads waiting for a yapd from before them")

  // A yapd with them.
  let focus = decoded(#"{"on": true, "activity": "idle", "mode": "focus", "until": "2026-10-02T15:00:00.000Z", "waiting": 2, "showing": null, "revision": 4}"#)
  check(focus?.mode == .focus && focus?.until == "2026-10-02T15:00:00.000Z" && focus?.waiting == 2, "reads the mode, when it ends and how many wait")
  check(focus?.revision == 4, "reads the rest of the state beside them")
  let quiet = decoded(#"{"on": true, "activity": "idle", "mode": "quiet", "until": "2026-10-03T08:00:00Z", "waiting": 0}"#)
  check(quiet?.mode == .quiet && quiet?.waiting == 0, "reads quiet")
  let normal = decoded(#"{"on": true, "activity": "idle", "mode": "normal", "waiting": 1}"#)
  check(normal?.mode == .normal && normal?.until == nil, "reads normal")

  // What it can't read of them leaves the rest of the state, as a yapd from before them.
  let odd = decoded(#"{"on": true, "activity": "idle", "mode": "away", "until": 3, "waiting": "two", "revision": 5}"#)
  check(odd?.revision == 5 && odd?.mode == nil && odd?.until == nil && odd?.waiting == 0, "reads a state whose mode, until and waiting it can't read")
  check(decoded(#"{"on": true, "activity": "idle", "mode": 1, "waiting": -3}"#)?.waiting == 0, "never counts fewer than none waiting")
  check(decoded(#"{"on": true, "activity": "idle", "mode": "normal", "until": "2026-10-02T15:00:00.000Z"}"#)?.until == nil, "takes no end for normal")
  check(decoded(#"{"on": true, "activity": "idle", "mode": "focus", "until": null}"#)?.until == nil, "reads focus with no end")
  let unreadable = decoded(#"{"on": true, "activity": "idle", "mode": "focus", "until": 3}"#)
  check(unreadable?.mode == .focus && unreadable?.until == nil, "reads focus whose end it can't read")

  // The icon: the moon in focus or quiet and the dot while a thread waits, only while yapd is on and quiet.
  let look = { (json: String) in Status.look(decoded(json)) }
  check(Status.look(nil) == .down, "shows yapd isn't running")
  check(look(#"{"on": false, "activity": "idle", "mode": "quiet", "waiting": 2}"#) == .off, "shows off, mode or not")
  check(look(#"{"on": true, "activity": "speaking", "mode": "focus", "waiting": 1}"#) == .speaking, "shows speaking over the moon and the dot")
  check(look(#"{"on": true, "activity": "listening", "mode": "focus"}"#) == .listening, "shows listening over the moon")
  check(look(#"{"on": true, "activity": "idle"}"#) == .on(moon: false, dot: false), "shows a yapd from before modes as on")
  check(look(#"{"on": true, "activity": "idle", "mode": "normal", "waiting": 0}"#) == .on(moon: false, dot: false), "shows normal with nothing waiting plain")
  check(look(#"{"on": true, "activity": "idle", "mode": "focus", "waiting": 0}"#) == .on(moon: true, dot: false), "shows the moon in focus")
  check(look(#"{"on": true, "activity": "idle", "mode": "quiet", "waiting": 0}"#) == .on(moon: true, dot: false), "shows the moon in quiet")
  check(look(#"{"on": true, "activity": "idle", "mode": "normal", "waiting": 1}"#) == .on(moon: false, dot: true), "shows the dot while a thread waits")
  check(look(#"{"on": true, "activity": "idle", "mode": "quiet", "waiting": 3}"#) == .on(moon: true, dot: true), "shows both")

  // What the menu says of them, in his time.
  let utc = TimeZone(identifier: "UTC")!
  let english = Locale(identifier: "en_US")
  let plain = { (line: String?) in line?.replacingOccurrences(of: "\u{202F}", with: " ") }
  let afternoon = Status.date("2026-10-02T14:03:00Z")!
  check(plain(focus?.modeLine(now: afternoon, zone: utc, locale: english)) == "Focus until 3:00 PM", "says when focus ends, not \(String(describing: focus?.modeLine(now: afternoon, zone: utc, locale: english)))")
  let night = Status.date("2026-10-02T23:30:00Z")!
  check(plain(quiet?.modeLine(now: night, zone: utc, locale: english)) == "Quiet until 8:00 AM tomorrow", "says quiet ends tomorrow, not \(String(describing: quiet?.modeLine(now: night, zone: utc, locale: english)))")
  let small = Status.date("2026-10-03T01:00:00Z")!
  check(plain(quiet?.modeLine(now: small, zone: utc, locale: english)) == "Quiet until 8:00 AM", "says quiet ends this morning")
  check(decoded(#"{"on": true, "activity": "idle", "mode": "focus", "until": "soon"}"#)?.modeLine(now: afternoon) == "Focus", "says focus with no time it can't read")
  check(normal?.modeLine(now: afternoon) == nil, "says nothing of normal")
  check(normal?.waitingLine == "1 Thread Waiting on You" && focus?.waitingLine == "2 Threads Waiting on You", "counts the threads waiting")
  check(quiet?.waitingLine == nil, "lists none waiting when none do")

  // What the menu sends: only the mode, with no on and no until, so yapd's own defaults and clock apply.
  let sent = { (change: ModeChange?) in change.flatMap { try? JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) as? [String: String] } }
  if let normal, let focus, let quiet {
    check(sent(normal.change(to: .focus)) == ["mode": "focus"], "asks for focus with a PUT that names only the mode")
    check(sent(normal.change(to: .quiet)) == ["mode": "quiet"], "asks for quiet with only the mode")
    check(sent(focus.change(to: .normal)) == ["mode": "normal"], "asks to end focus with only the mode")
    check(sent(focus.change(to: .focus)) == ["mode": "focus"], "asks for focus again, which starts its hour again")
    check(sent(quiet.change(to: .focus)) == ["mode": "focus"], "asks for focus from quiet")
    check(normal.change(to: .normal) == nil, "asks nothing to go back to normal when it's normal already")
  } else {
    check(false, "reads a yapd with modes")
  }
  check(Mode.allCases.map(\.item) == ["Normal", "Focus for an Hour", "Quiet until Morning"], "offers the three modes")
  let asked = (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(Utterance.whoNeedsMe))) as? [String: String]
  check(asked == ["text": "who needs me?"], "asks who's waiting as he'd say it, not \(String(describing: asked))")
}
