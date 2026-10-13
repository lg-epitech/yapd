import Foundation

/// The menu reads the threads with the latest updates from any yapd, old or new, draws each icon it's sent, or the monogram it
/// carries, in T3 Code's colours as yapd makes them, tells how long ago each ended, mutes and replays a thread by its key, and
/// has its subagents read, a subagent's by the key of the thread it's part of, which it reads whether it's muted.
@MainActor func checkRecent() {
  let decoded = { (json: String) in try? JSONDecoder().decode(Status.self, from: Data(json.utf8)) }
  let row = """
    {"key": "t3:Rosie:850299f8", "machine": "Rosie", "thread": "850299f8", "title": "Migrate the Tezos integration",
     "project": {"name": "integration", "id": "5c1e", "icon": {"kind": "image", "url": "/projects/Rosie/5c1e/icon", "revision": "9f2c", "text": "IN", "color": "indigo"}},
     "text": "integration. The migration is done.", "at": "2026-10-02T14:01:40.000Z", "muted": true, "until": "2026-10-02T15:00:00.000Z", "waiting": false}
    """
  let update = #"{"id": "4b9f", "project": "yapd", "text": "yapd. The tests pass.", "at": "2026-10-02T14:03:11.000Z"}"#

  // A yapd that sends both, one from before `recent`, and one that no longer sends `updates`.
  let both = decoded(#"{"on": true, "activity": "idle", "updates": [\#(update)], "recent": [\#(row)], "showing": null, "revision": 3}"#)
  check(both?.updates.map(\.id) == ["4b9f"], "reads the updates beside the recent threads")
  check(both?.recent?.count == 1, "reads the recent threads")
  let first = both?.recent?.first
  check(first?.key == "t3:Rosie:850299f8" && first?.thread == "850299f8" && first?.title == "Migrate the Tezos integration", "reads a thread's key, id and title")
  check(first?.muted == true && first?.until == "2026-10-02T15:00:00.000Z" && first?.waiting == false, "reads whether a thread is muted, until when, and waiting")
  check(first?.replayable == true, "takes a row from a yapd that doesn't say whether it can be heard again as one that can")
  check(first?.ended == Date(timeIntervalSince1970: 1_790_949_700), "reads when a thread's turn ended, not \(String(describing: first?.ended))")
  check(first?.project == Status.Recent.Project(name: "integration", id: "5c1e", icon: .image(url: "/projects/Rosie/5c1e/icon", revision: "9f2c", instead: Status.Monogram(text: "IN", color: "indigo"))), "reads a project and its image")
  let old = decoded(#"{"on": false, "activity": "idle", "updates": [\#(update)]}"#)
  check(old != nil && old?.recent == nil && old?.updates.count == 1, "reads a yapd from before recent threads, with its updates to hear again")
  let new = decoded(#"{"on": true, "activity": "speaking", "recent": [\#(row)]}"#)
  check(new?.updates.isEmpty == true && new?.recent?.count == 1, "reads a yapd that sends no updates")
  check(decoded(#"{"on": true, "activity": "idle", "recent": []}"#)?.recent?.isEmpty == true, "tells no recent threads from a yapd that sends none")
  // A row the app can't read leaves the others, and an icon it can't read leaves its row.
  let odd = decoded(#"""
    {"on": true, "activity": "idle", "recent": [
      {"key": "t3:Rosie:1", "machine": "Rosie"},
      {"key": "session:rig:claude:abc", "machine": "rig", "thread": null, "title": "Claude session on rig", "project": {"name": "Tezos 2", "icon": {"kind": "sparkles"}}, "text": "Done.", "at": "2026-10-02T14:01:40Z", "muted": false, "waiting": true},
      \#(row)
    ]}
    """#)
  check(odd?.recent?.map(\.key) == ["session:rig:claude:abc", "t3:Rosie:850299f8"], "leaves out only the row it can't read, not \(String(describing: odd?.recent?.map(\.key)))")
  let session = odd?.recent?.first
  check(session?.thread == nil && session?.project == Status.Recent.Project(name: "Tezos 2"), "keeps a session row whose icon can't be read, with none")
  check(session?.ended == Date(timeIntervalSince1970: 1_790_949_700), "reads a time without fractions of a second")

  // Whether a thread's subagents are read, and the thread a subagent's row is part of; none of either from a yapd from before them,
  // nor on a session's row, and what can't be read of them as none.
  let fields = { (fields: String) in
    decoded(#"{"on": true, "activity": "idle", "recent": [{"key": "t3:Rosie:7", "machine": "Rosie", "thread": "7", "title": "Sol review: release blockers", "text": "Done.", "at": "2026-10-02T14:01:40Z"\#(fields)}]}"#)?.recent?.first
  }
  let part = fields(#", "subagents": true, "head": {"key": "t3:Rosie:850299f8", "title": "Migrate the Tezos integration"}"#)
  check(part?.subagents == true && part?.head == Status.Recent.Head(key: "t3:Rosie:850299f8", title: "Migrate the Tezos integration"), "reads a subagent's row with the thread it's part of, not \(String(describing: part?.head))")
  check(fields(#", "subagents": false"#)?.subagents == false && fields(#", "subagents": false"#)?.head == nil, "reads a thread whose subagents aren't read")
  check(first?.subagents == nil && first?.head == nil && session?.subagents == nil, "reads neither from a yapd from before them, nor of a session")
  check(fields(#", "subagents": "yes", "head": {"key": 7}"#).map { $0.subagents == nil && $0.head == nil } == true, "reads a row whose subagents and head it can't read as one with neither")
  check(fields(#", "subagents": true, "head": "t3:Rosie:850299f8""#).map { $0.subagents == nil && $0.head == nil } == true, "offers nothing to read for a subagent whose thread it can't read, rather than its own")
  // Whether the thread a subagent is part of is muted, which mutes it too; not from a yapd from before it, nor what can't be read.
  let headMuted = { (muted: String) in fields(#", "muted": true, "subagents": true, "head": {"key": "t3:Rosie:850299f8", "title": "Migrate the Tezos integration"\#(muted)}"#)?.head }
  check(headMuted(#", "muted": true"#) == Status.Recent.Head(key: "t3:Rosie:850299f8", title: "Migrate the Tezos integration", muted: true), "reads that a subagent's thread is muted, not \(String(describing: headMuted(#", "muted": true"#)))")
  check(headMuted(#", "muted": false"#)?.muted == false && part?.head?.muted == false, "reads that it isn't, and takes it as not from a yapd from before it")
  check(headMuted(#", "muted": "yes""#) == Status.Recent.Head(key: "t3:Rosie:850299f8", title: "Migrate the Tezos integration"), "reads a thread's mute it can't read as none, keeping the thread")

  // Whether a row can be heard again, as yapd says, and a row it can't still listed and muted as before.
  let says = { (replayable: String) in
    decoded(#"{"on": true, "activity": "idle", "recent": [{"key": "session:Rosie:claude:s", "machine": "Rosie", "thread": null, "title": "Claude session", "text": "Done.", "at": "2026-10-02T14:01:40Z", "muted": true, "waiting": false, "replayable": \#(replayable)}]}"#)?.recent?.first
  }
  check(says("false")?.replayable == false && says("true")?.replayable == true, "reads whether a row can be heard again")
  check(says("false")?.key == "session:Rosie:claude:s" && says("false")?.muted == true && says("false")?.label == "Claude session", "lists a row that can't be heard again as any other")
  check(says("\"no\"")?.replayable == true, "takes a row whose replayable it can't read as one that can be heard again")
  if let unreachable = says("false"), let first {
    check(!unreachable.hearable(on: true) && !unreachable.hearable(on: false), "never lets him hear again a row yapd can't say again")
    check(first.hearable(on: true) && !first.hearable(on: false), "lets him hear again a row yapd can say again, while it's on")
    check(Muting(unreachable, on: false).url(at: URL(string: "http://127.0.0.1:4747")!)?.absoluteString == "http://127.0.0.1:4747/threads/session%3ARosie%3Aclaude%3As/mute", "still unmutes a row that can't be heard again")
  } else {
    check(false, "reads a row that can't be heard again")
  }

  // Every kind of icon, and one the app doesn't know, which is the monogram it carries.
  let icon = { (json: String) in try? JSONDecoder().decode(Status.Icon.self, from: Data(json.utf8)) }
  let indigo = Status.Monogram(text: "IN", color: "indigo")
  let icons: [(String, Status.Icon?)] = [
    (#"{"kind": "image", "url": "/projects/Rosie/5c1e/icon", "revision": "9f2c", "text": "IN", "color": "indigo"}"#, .image(url: "/projects/Rosie/5c1e/icon", revision: "9f2c", instead: indigo)),
    (#"{"kind": "emoji", "emoji": "🦀", "text": "IN", "color": "indigo"}"#, .emoji("🦀", instead: indigo)),
    (#"{"kind": "monogram", "text": "TZ", "color": "teal"}"#, .monogram(Status.Monogram(text: "TZ", color: "teal"))),
    (#"{"kind": "lucide", "name": "star", "text": "IN", "color": "indigo"}"#, .monogram(indigo)),
    (#"{"text": "IN", "color": "indigo"}"#, .monogram(indigo)),
    (#"{"kind": "image", "text": "IN", "color": "indigo"}"#, .monogram(indigo)),
    (#"{"kind": "emoji", "emoji": "", "text": "IN", "color": "indigo"}"#, .monogram(indigo)),
    (#"{"kind": "emoji", "emoji": "🦀"}"#, .emoji("🦀", instead: nil)),
    (#"{"kind": "lucide", "name": "star"}"#, nil),
    (#"{"kind": "monogram", "text": "", "color": "teal"}"#, nil),
  ]
  for (json, expected) in icons {
    check(icon(json) == expected, "reads \(json) as \(String(describing: expected)), not \(String(describing: icon(json)))")
  }
  // What's drawn when the icon can't be: the monogram it carries, else one made from the project's name, as T3 Code does.
  func listed(_ project: Status.Recent.Project?) -> Status.Recent {
    Status.Recent(key: "t3:Rosie:1", machine: "Rosie", title: "Migrate the Tezos integration", project: project, text: "Done.", at: "2026-10-02T14:01:40.000Z")
  }
  check(listed(Status.Recent.Project(name: "integration", icon: .image(url: "/i", revision: "1", instead: Status.Monogram(text: "TZ", color: "teal")))).monogram == Status.Monogram(text: "TZ", color: "teal"), "draws the monogram an image carries")
  check(listed(Status.Recent.Project(name: "integration", icon: .emoji("🦀", instead: nil))).monogram == indigo, "draws the project's own monogram for an emoji that carries none")
  check(listed(Status.Recent.Project(name: "integration")).monogram == indigo, "draws the project's own monogram when it has no icon")
  check(listed(nil).monogram == nil, "draws no monogram for a row with no project")

  // T3 Code's colours, in its order, as yapd has them, and the monogram it makes from a name, as T3 Code's own functions do.
  let names = ["gray", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose"]
  check(Tint.all.map(\.name) == names, "has T3 Code's colours in its order, not \(Tint.all.map(\.name))")
  check(Set(Tint.all.map(\.light)).count == 18 && Set(Tint.all.map(\.dark)).count == 18, "has a shade of its own for each colour")
  check(Tint.named("indigo")?.light == 0x4F39F6 && Tint.named("indigo")?.dark == 0x7C86FF && Tint.named("chartreuse") == nil, "finds a colour by its name")
  if let colors = ProcessInfo.processInfo.environment["YAPD_COLORS"] {
    check(Tint.all.map(\.name) == colors.split(separator: ",").map(String.init), "has yapd's colours, \(colors), in its order")
  }
  var vectors: [[String]] = [
    ["yapd", "YD", "pink"], ["integration", "IN", "indigo"], ["Tezos 2", "T2", "blue"], ["integration-connectors", "IC", "cyan"],
    ["", "PR", "fuchsia"], ["🦀", "PR", "green"], ["Ünïcode", "ÜE", "pink"], ["std", "SD", "red"], ["Mina SSV2", "MS", "lime"], ["a", "AA", "emerald"],
  ]
  // yapd's own, as bun test runs them through its Icons.monogram.
  if let daemon = ProcessInfo.processInfo.environment["YAPD_MONOGRAMS"] {
    let given = try? JSONDecoder().decode([[String]].self, from: Data(daemon.utf8))
    check(given?.isEmpty == false, "reads yapd's monograms")
    vectors += given ?? []
  }
  for vector in vectors {
    let made = Status.Monogram(of: vector[0])
    check(made == Status.Monogram(text: vector[1], color: vector[2]), "makes \(vector[1]) in \(vector[2]) of \(vector[0].debugDescription), not \(made)")
  }

  // How long ago, as the menu says it.
  let now = Date(timeIntervalSince1970: 1_790_949_700)
  let agos: [(TimeInterval, String)] = [
    (-30, "now"), (0, "now"), (59, "now"), (60, "1 min ago"), (3 * 60 + 20, "3 min ago"), (59 * 60 + 59, "59 min ago"), (60 * 60, "1 h ago"),
    (2 * 3600 + 1800, "2 h ago"), (23 * 3600 + 3599, "23 h ago"), (24 * 3600, "yesterday"), (47 * 3600, "yesterday"), (48 * 3600, "2 days ago"),
    (6 * 86400 + 3600, "6 days ago"),
  ]
  for (seconds, label) in agos {
    check(ago(now.addingTimeInterval(-seconds), now: now) == label, "says \(label) for \(seconds) s ago, not \(ago(now.addingTimeInterval(-seconds), now: now))")
  }
  check(first?.label == "integration · Migrate the Tezos integration", "names a row by its project and title, not \(String(describing: first?.label))")
  check(first?.detail(now: now.addingTimeInterval(180)) == "3 min ago · muted", "says how long ago a muted row ended, not \(String(describing: first?.detail(now: now.addingTimeInterval(180))))")
  check(session?.label == "Tezos 2 · Claude session on rig" && session?.detail(now: now) == "now · waiting on you", "says a row waits on him")
  let long = listed(Status.Recent.Project(name: "integration-connectors"))
  let longer = Status.Recent(key: long.key, machine: long.machine, title: String(repeating: "Tezos ", count: 12), project: long.project, text: long.text, at: long.at)
  check(longer.label.count == 60 && longer.label.hasSuffix("…"), "cuts a long name short, not to \(longer.label.count)")

  // Muting and hearing a thread again, by its key, encoded as one piece of the path, on yapd's API and nowhere else.
  let api = URL(string: "http://127.0.0.1:4747")!
  guard let first else { return }
  let muting = Muting(first, on: true)
  check(muting.method == "PUT" && muting.url(at: api)?.absoluteString == "http://127.0.0.1:4747/threads/t3%3ARosie%3A850299f8/mute", "mutes a thread by PUT to its key, not \(muting.method) \(String(describing: muting.url(at: api)))")
  let unmuting = Muting(first, on: false)
  check(unmuting.method == "DELETE" && unmuting.url(at: api) == muting.url(at: api), "takes a mute off by DELETE to the same address")
  let odder = Status.Recent(key: "session:rig:claude:a/b?c#d e%f", machine: "rig", title: "Claude session on rig", text: "Done.", at: "2026-10-02T14:01:40Z")
  check(Muting(odder, on: true).url(at: api)?.absoluteString == "http://127.0.0.1:4747/threads/session%3Arig%3Aclaude%3Aa%2Fb%3Fc%23d%20e%25f/mute", "encodes every part of a key but its letters, numbers and -._~, not \(String(describing: Muting(odder, on: true).url(at: api)))")
  check(Muting(odder, on: true).url(at: api)?.path(percentEncoded: false) == "/threads/session:rig:claude:a/b?c#d e%f/mute", "keeps the key whole")
  let replaying = Replaying(first)
  check(replaying.method == "POST" && replaying.url(at: api)?.absoluteString == "http://127.0.0.1:4747/threads/t3%3ARosie%3A850299f8/replay", "hears a thread again by POST to its key")
  check(Muting(first, on: true).url(at: URL(string: "http://127.0.0.1:4848")!)?.absoluteString == "http://127.0.0.1:4848/threads/t3%3ARosie%3A850299f8/mute", "asks yapd on its own port")

  // A thread's subagents read by PUT to its key, and kept to yapd again by DELETE; a subagent's by its thread's key, never its own,
  // and its mute by its own.
  let reading = Subagents(first, on: true)
  check(reading.method == "PUT" && reading.body == nil && reading.url(at: api)?.absoluteString == "http://127.0.0.1:4747/threads/t3%3ARosie%3A850299f8/subagents", "reads a thread's subagents by PUT to its key, not \(reading.method) \(String(describing: reading.url(at: api)))")
  let keeping = Subagents(first, on: false)
  check(keeping.method == "DELETE" && keeping.body == nil && keeping.url(at: api) == reading.url(at: api), "keeps them to yapd again by DELETE to the same address")
  if let part {
    check(Subagents(part, on: false).url(at: api)?.absoluteString == "http://127.0.0.1:4747/threads/t3%3ARosie%3A850299f8/subagents", "stops reading a subagent's by the key of the thread it's part of")
    check(Subagents(part, on: true).method == "PUT" && Subagents(part, on: true).url(at: api) == reading.url(at: api), "reads them again by the same address")
    check(Muting(part, on: true).url(at: api)?.absoluteString == "http://127.0.0.1:4747/threads/t3%3ARosie%3A7/mute" && Muting.forAnHour(part, from: now).url(at: api) == Muting(part, on: true).url(at: api), "mutes a subagent by its own key, never its thread's")
  } else {
    check(false, "reads a subagent's row")
  }

  check(imageAddress("/projects/Rosie/5c1e/icon", at: api)?.absoluteString == "http://127.0.0.1:4747/projects/Rosie/5c1e/icon", "fetches a project's image from yapd")
  for path in ["//evil.example/icon", "https://evil.example/icon", "projects/Rosie/5c1e/icon", "/projects/x/icon?token=1", "/projects/x/icon#a", "/\\evil.example/icon", "file:///etc/passwd"] {
    check(imageAddress(path, at: api) == nil, "never fetches an image from \(path)")
  }
}
