import Foundation

/// A panel and a yapd to follow, keeping what's done to them: each fetch, what's put up, hidden or taken down, and each wait.
@MainActor
private final class Watched {
  /// How many fetches fail before one doesn't.
  var failing: Int
  var fetches: [String] = []
  var done: [String] = []
  var waits: [Duration] = []

  init(failing: Int = 0) {
    self.failing = failing
  }

  var doing: Following.Doing {
    Following.Doing(
      fetch: { id in
        self.fetches.append(id)
        guard self.failing == 0 else {
          self.failing -= 1
          return nil
        }
        return Card(id: id, kind: "said", title: "What I said", markdown: "### I said\n\nOne running.", url: nil, caption: "One running.")
      },
      show: { card, talking in self.done.append(talking ? "show \(card.id)" : "show \(card.id) quietly") },
      hide: { self.done.append("hide") },
      takeDown: { self.done.append("take down") },
      wait: { delay in self.waits.append(delay) }
    )
  }
}

/// What `/state` points at: a card put up a moment ago, `fresh`, or a while before.
private func pointing(_ id: String, fresh: Bool) -> Status.Showing {
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
    following.follow(pointing("c2", fresh: true), connecting: false)
    await following.settled()
    following.follow(pointing("c2", fresh: true), connecting: false)
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
    following.follow(pointing("c3", fresh: true), connecting: false)
    await following.settled()
    check(
      watched.fetches.count == 4 && watched.waits == [.seconds(1), .seconds(2), .seconds(4)] && watched.done == ["take down"] && following.shown == nil,
      "gives up on a card it can't fetch after a few tries, not after \(watched.fetches.count), having done \(watched.done)"
    )
  }

  // Pointed at another while it's fetched, it's the other that's put up.
  do {
    let watched = Watched()
    let following = Following(watched.doing)
    following.follow(pointing("c4", fresh: true), connecting: false)
    following.follow(pointing("c5", fresh: true), connecting: false)
    await following.settled()
    check(watched.done == ["show c5"], "puts up only the card yapd points at last, not \(watched.done)")
  }

  // It faded while yapd was away, so when yapd comes back still pointing at it, it isn't on screen: yapd takes it down too.
  for fresh in [false, true] {
    let watched = Watched()
    let following = Following(watched.doing)
    following.follow(pointing("c1", fresh: fresh), connecting: false)
    await following.settled()
    following.away()
    following.closed("c1")
    following.follow(pointing("c1", fresh: fresh), connecting: true)
    await following.settled()
    check(
      watched.done == ["show c1", "hide", "take down"] && following.shown == nil && watched.fetches == ["c1"],
      "has yapd take down a card \(fresh ? "put up a moment ago" : "put up a while ago") that faded while it was away, not \(watched.done)"
    )
  }

  // Still up when yapd comes back, it stays up, and is neither fetched again nor taken down.
  do {
    let watched = Watched()
    let following = Following(watched.doing)
    following.follow(pointing("c6", fresh: true), connecting: true)
    await following.settled()
    following.away()
    following.follow(pointing("c6", fresh: false), connecting: true)
    await following.settled()
    check(watched.done == ["show c6"] && watched.fetches == ["c6"] && following.shown == "c6", "keeps up a card still up when yapd comes back, not \(watched.done)")
  }

  // Closed while yapd is there, yapd takes it down at once; one it no longer points at, it doesn't.
  do {
    let watched = Watched()
    let following = Following(watched.doing)
    following.follow(pointing("c7", fresh: true), connecting: true)
    await following.settled()
    following.closed("c7")
    following.follow(pointing("c8", fresh: true), connecting: false)
    await following.settled()
    following.closed("c7")
    check(watched.done == ["show c7", "take down", "show c8"], "has yapd take down only the card it points at once it's closed, not \(watched.done)")
  }
}
