import Foundation

/// A panel and a yapd to follow, keeping what's done to them: each fetch, what's put up, hidden, taken down or put back up, and
/// each wait.
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
          return .failed
        }
        return .card(Card(id: id, kind: "said", title: "What I said", markdown: "### I said\n\nOne running.", url: nil, caption: "One running."))
      },
      show: { card, talking in self.done.append(talking ? "show \(card.id)" : "show \(card.id) quietly") },
      hide: { self.done.append("hide") },
      takeDown: { down in self.done.append(down.shown.map { "take down \(down.id) shown \($0)" } ?? "take down \(down.id)") },
      putBack: { back in self.done.append(back.revision.map { "put back \(back.id) at \($0)" } ?? "put back \(back.id)") },
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

/// The panel puts up the card yapd points at once it's fetched, trying again when that fails, a while longer apart each time, then
/// giving up on it.
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
}
