import Foundation

/// A panel and a yapd to follow, keeping what's done to them: each fetch, what's put up, hidden, taken down or put back up, and
/// each wait.
@MainActor
private final class Watched {
  /// How many fetches fail before one doesn't.
  var failing: Int
  /// Whether yapd says it no longer has a card fetched, once none fail.
  var missing: Bool
  /// A card whose fetch waits until it's let go, as one that's slow to come back.
  var holding: String?
  /// Whether having yapd put a card back up waits until it's let go, as a request that's slow to get there.
  var holdingBack = false
  var fetches: [String] = []
  var done: [String] = []
  var waits: [Duration] = []
  /// The fetch of the card held, or having it put back up, once it's started.
  private var held: CheckedContinuation<Void, Never>?

  init(failing: Int = 0, missing: Bool = false, holding: String? = nil) {
    self.failing = failing
    self.missing = missing
    self.holding = holding
  }

  /// Once the card held is being fetched.
  func fetching() async {
    while held == nil { await Task.yield() }
  }

  /// Once yapd is being asked to put a card back up, while that's held.
  func puttingBack() async {
    while held == nil { await Task.yield() }
  }

  /// Lets the fetch of the card held come back, or having it put back up.
  func letGo() {
    held?.resume()
    held = nil
  }

  var doing: Following.Doing {
    Following.Doing(
      fetch: { id in
        self.fetches.append(id)
        if id == self.holding { await withCheckedContinuation { self.held = $0 } }
        guard self.failing == 0 else {
          self.failing -= 1
          return .failed
        }
        if self.missing { return .missing }
        return .card(Card(id: id, kind: "said", title: "What I said", markdown: "### I said\n\nOne running.", url: nil, caption: "One running."))
      },
      show: { card, talking in self.done.append(talking ? "show \(card.id)" : "show \(card.id) quietly") },
      hide: { self.done.append("hide") },
      takeDown: { id in self.done.append("take down \(id)") },
      putBack: { back in
        self.done.append(back.revision.map { "put back \(back.id) at \($0)" } ?? "put back \(back.id)")
        guard self.holdingBack else { return }
        await withCheckedContinuation { self.held = $0 }
        if Task.isCancelled { self.done.append("stopped putting back \(back.id)") }
      },
      wait: { delay in self.waits.append(delay) }
    )
  }
}

/// What `/state` points at: a card put up a moment ago, `fresh`, or a while before.
func pointing(_ id: String, fresh: Bool) -> Status.Showing {
  let format = ISO8601DateFormatter()
  format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  let at = format.string(from: fresh ? Date() : Date(timeIntervalSinceNow: -3600))
  return try! JSONDecoder().decode(Status.Showing.self, from: Data(#"{"id": "\#(id)", "at": "\#(at)"}"#.utf8))
}

/// The panel puts up the card yapd points at once it's fetched, trying again when that fails, and checks what it shows against what yapd points at whenever it connects.
@MainActor func checkFollowing() async {
  // Fetching it failed once: it's tried again a second later, and put up, with nothing more fetched for the same card after.
  do {
    let watched = Watched(failing: 1)
    let following = Following(watched.doing)
    following.follow(pointing("c2", fresh: true), revision: nil, connecting: false)
    await following.settled()
    following.follow(pointing("c2", fresh: true), revision: nil, connecting: false)
    await following.settled()
    check(
      watched.fetches == ["c2", "c2"] && watched.waits == [.seconds(1)] && watched.done == ["show c2"] && following.shown == "c2",
      "puts a card up once fetching it works again, not \(watched.done) after fetching \(watched.fetches)"
    )
  }

  // Failing every time, it's tried a few times, a while longer apart each time, then given up on, and yapd takes it down too.
  do {
    let watched = Watched(failing: 10)
    let following = Following(watched.doing)
    following.follow(pointing("c3", fresh: true), revision: nil, connecting: false)
    await following.settled()
    check(
      watched.fetches.count == 4 && watched.waits == [.seconds(1), .seconds(2), .seconds(4)] && watched.done == ["take down c3"] && following.shown == nil,
      "gives up on a card it can't fetch after a few tries, not after \(watched.fetches.count), having done \(watched.done)"
    )
  }

  // Pointed at another while it's fetched, it's the other that's put up.
  do {
    let watched = Watched()
    let following = Following(watched.doing)
    following.follow(pointing("c4", fresh: true), revision: nil, connecting: false)
    following.follow(pointing("c5", fresh: true), revision: nil, connecting: false)
    await following.settled()
    check(watched.done == ["show c5"], "puts up only the card yapd points at last, not \(watched.done)")
  }

  // It faded while yapd was away, so when yapd comes back still pointing at it, it isn't on screen: yapd takes it down too.
  for fresh in [false, true] {
    let watched = Watched()
    let following = Following(watched.doing)
    following.follow(pointing("c1", fresh: fresh), revision: nil, connecting: false)
    await following.settled()
    following.away()
    following.closed("c1")
    following.follow(pointing("c1", fresh: fresh), revision: nil, connecting: true)
    await following.settled()
    check(
      watched.done == ["show c1", "hide", "take down c1"] && following.shown == nil && watched.fetches == ["c1"],
      "has yapd take down a card \(fresh ? "put up a moment ago" : "put up a while ago") that faded while it was away, not \(watched.done)"
    )
  }

  // Still up when yapd comes back, it stays up, and is neither fetched again nor taken down.
  do {
    let watched = Watched()
    let following = Following(watched.doing)
    following.follow(pointing("c6", fresh: true), revision: nil, connecting: true)
    await following.settled()
    following.away()
    following.follow(pointing("c6", fresh: false), revision: nil, connecting: true)
    await following.settled()
    check(watched.done == ["show c6"] && watched.fetches == ["c6"] && following.shown == "c6", "keeps up a card still up when yapd comes back, not \(watched.done)")
  }

  // Closed while yapd is there, yapd takes it down at once; one it no longer points at, it doesn't.
  do {
    let watched = Watched()
    let following = Following(watched.doing)
    following.follow(pointing("c7", fresh: true), revision: nil, connecting: true)
    await following.settled()
    following.closed("c7")
    following.follow(pointing("c8", fresh: true), revision: nil, connecting: false)
    await following.settled()
    following.closed("c7")
    check(watched.done == ["show c7", "take down c7", "show c8"], "has yapd take down only the card it points at once it's closed, not \(watched.done)")
  }

  // Closed as yapd puts up another, its request gets there after the other went up: yapd, taking down only the card named, keeps the other up.
  do {
    var up: String? = "c9"
    var requests: [String] = []
    var shown: String?
    let following = Following(Following.Doing(
      fetch: { id in .card(Card(id: id, kind: "said", title: "What I said", markdown: "### I said\n\nOne running.", url: nil, caption: nil)) },
      show: { card, _ in shown = card.id },
      hide: { shown = nil },
      takeDown: { id in requests.append(id) },
      putBack: { _ in },
      wait: { _ in }
    ))
    following.follow(pointing("c9", fresh: true), revision: nil, connecting: true)
    await following.settled()
    following.closed("c9")
    up = "c10"
    following.follow(pointing("c10", fresh: true), revision: nil, connecting: false)
    await following.settled()
    for id in requests where up == id { up = nil }
    following.follow(up.map { pointing($0, fresh: true) }, revision: nil, connecting: false)
    check(
      requests == ["c9"] && up == "c10" && shown == "c10",
      "has yapd take down only the card it closed, not \(requests), leaving \(up ?? "none") up and \(shown ?? "none") shown"
    )
  }

  // Shown again from the menu, with nothing newer meanwhile, it's put up with nothing said of it, and yapd puts it back up too, even
  // with states coming in meanwhile that still point at none.
  do {
    let watched = Watched()
    let following = Following(watched.doing)
    following.follow(pointing("c11", fresh: true), revision: nil, connecting: true)
    await following.settled()
    following.closed("c11")
    following.follow(nil, revision: nil, connecting: false)
    watched.holding = "c11"
    watched.done = []
    following.showAgain("c11") { watched.done.append("gone") }
    await watched.fetching()
    following.follow(nil, revision: nil, connecting: false)
    watched.letGo()
    await following.settled()
    check(
      watched.done == ["show c11 quietly", "put back c11"] && following.shown == "c11" && following.wanted == "c11",
      "shows a card again and has yapd put it back up, not \(watched.done)"
    )
  }

  // Gone from yapd, there's nothing to show again.
  do {
    let watched = Watched(missing: true)
    let following = Following(watched.doing)
    following.showAgain("c12") { watched.done.append("gone") }
    await following.settled()
    check(watched.done == ["gone"] && following.shown == nil, "shows nothing again of a card yapd no longer has, not \(watched.done)")
  }

  // Fetching it failed, as while yapd is slow or restarting: nothing shows, it isn't taken for gone, and asked for again once
  // yapd is back, it shows.
  do {
    let watched = Watched(failing: 1)
    let following = Following(watched.doing)
    following.showAgain("c19") { watched.done.append("gone") }
    await following.settled()
    let failed = watched.done
    following.showAgain("c19") { watched.done.append("gone") }
    await following.settled()
    check(
      failed == [] && watched.done == ["show c19 quietly", "put back c19"] && following.shown == "c19",
      "shows a card again once yapd is back, having kept it after failing to fetch it, not \(failed) then \(watched.done)"
    )
  }

  // What yapd answers when a card is fetched: the card, or that it no longer has it only when it says so, with a 404; anything
  // else, it may well still have it.
  do {
    let card = Card(id: "c20", kind: "said", title: "What I said", markdown: "### I said\n\nOne running.", url: nil, caption: nil)
    let body = try! JSONEncoder().encode(["id": "c20", "kind": "said", "title": "What I said", "markdown": "### I said\n\nOne running."])
    let answered = { (status: Int, body: Data) in
      Fetched(body, HTTPURLResponse(url: URL(string: "http://127.0.0.1:4747/cards/c20")!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
    let fetched = [answered(200, body), answered(404, Data()), answered(503, Data()), answered(500, body), answered(200, Data("{".utf8))]
    check(
      fetched == [.card(card), .missing, .failed, .failed, .failed],
      "reads yapd's answers as the card, missing, then failed three times, not \(fetched)"
    )
  }

  // yapd puts up another before the card shown again is fetched: the other stays up, and yapd keeps pointing at it.
  do {
    let watched = Watched(holding: "c13")
    let following = Following(watched.doing)
    following.showAgain("c13") { watched.done.append("gone") }
    await watched.fetching()
    following.follow(pointing("c14", fresh: true), revision: nil, connecting: true)
    watched.letGo()
    await following.settled()
    check(
      watched.done == ["show c14"] && following.shown == "c14" && following.wanted == "c14",
      "keeps up a card yapd put up while another was fetched to show again, not \(watched.done)"
    )
  }

  // yapd hides the card before the one shown again is fetched: it stays hidden, and yapd isn't asked to put it back up.
  do {
    let watched = Watched(holding: "c15")
    let following = Following(watched.doing)
    following.follow(pointing("c16", fresh: true), revision: nil, connecting: true)
    await following.settled()
    following.showAgain("c15") { watched.done.append("gone") }
    await watched.fetching()
    following.follow(nil, revision: nil, connecting: false)
    watched.letGo()
    await following.settled()
    check(
      watched.done == ["show c16", "hide"] && following.shown == nil && following.wanted == nil,
      "keeps hidden a card yapd hid while another was fetched to show again, not \(watched.done)"
    )
  }

  // Put away from the panel before the card shown again is fetched, it isn't put back up; and its fetch, stopped, coming back with
  // nothing, says nothing of whether yapd still has it.
  do {
    let watched = Watched(holding: "c17")
    let following = Following(watched.doing)
    following.follow(pointing("c18", fresh: true), revision: nil, connecting: true)
    await following.settled()
    watched.failing = 1
    following.showAgain("c17") { watched.done.append("gone") }
    await watched.fetching()
    following.closed("c18")
    watched.letGo()
    await following.settled()
    check(watched.done == ["show c18", "take down c18"] && following.shown == nil, "keeps away a card put away while another was fetched to show again, not \(watched.done)")
  }

  // Shown again from the menu, yapd is asked to put it back up at the revision of the state followed last as it was asked for,
  // even with states coming in meanwhile at the same revision, like one that only says yapd started speaking.
  do {
    let watched = Watched(holding: "c21")
    let following = Following(watched.doing)
    following.follow(nil, revision: 7, connecting: true)
    following.showAgain("c21") { watched.done.append("gone") }
    await watched.fetching()
    following.follow(nil, revision: 7, connecting: false)
    watched.letGo()
    await following.settled()
    check(
      watched.done == ["hide", "show c21 quietly", "put back c21 at 7"] && following.shown == "c21" && following.wanted == "c21",
      "has yapd put a card shown again back up at the revision it was at as it was asked for, not \(watched.done)"
    )
  }

  // yapd puts a card up and takes it down, or is asked to take one down, while the card shown again is fetched, with none up
  // before or after: that came later, so it isn't shown, nor put back up, which yapd would turn away anyway.
  do {
    let watched = Watched(holding: "c22")
    let following = Following(watched.doing)
    following.follow(nil, revision: 7, connecting: true)
    following.showAgain("c22") { watched.done.append("gone") }
    await watched.fetching()
    following.follow(nil, revision: 8, connecting: false)
    watched.letGo()
    await following.settled()
    check(
      watched.done == ["hide"] && following.shown == nil && following.wanted == nil,
      "keeps away a card shown again once yapd's revision moved on while it was fetched, not \(watched.done)"
    )
  }

  // Put away while yapd is still being asked to put it back up, that request is stopped, unless it's gone already, which yapd,
  // asked to take it down since, turns away.
  do {
    let watched = Watched()
    watched.holdingBack = true
    let following = Following(watched.doing)
    following.follow(nil, revision: 3, connecting: true)
    following.showAgain("c23") { watched.done.append("gone") }
    await watched.puttingBack()
    following.closed("c23")
    watched.letGo()
    await following.settled()
    check(
      watched.done == ["hide", "show c23 quietly", "put back c23 at 3", "take down c23", "stopped putting back c23"] && following.shown == nil,
      "stops having yapd put back up a card put away meanwhile, not \(watched.done)"
    )
  }

  // yapd's revision is read from its state, and sent with a card to put back up; a yapd too old to count them sends none, and
  // gets none back, as before.
  do {
    let read = [
      #"{"on": true, "activity": "idle", "updates": [], "showing": null, "revision": 7}"#,
      #"{"on": true, "activity": "idle", "updates": []}"#,
    ].map { try! JSONDecoder().decode(Status.self, from: Data($0.utf8)).revision }
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    let sent = [PutBack(id: "c24", revision: 7), PutBack(id: "c24", revision: nil)].map { String(decoding: try! encoder.encode($0), as: UTF8.self) }
    check(
      read == [7, nil] && sent == [#"{"id":"c24","revision":7}"#, #"{"id":"c24"}"#],
      "reads yapd's revision and sends it back with a card to put back up, not \(read) and \(sent)"
    )
  }
}
