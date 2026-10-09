import Foundation

/// A card on the panel, keeping each wait before it fades, how many times it faded or was put away after, and whether it shows.
@MainActor
private final class Faded {
  var waits: [Duration] = []
  var fades = 0
  var closes = 0
  /// Whether the card shows: a fade leaves it unseen, even stopped part way, until it's kept.
  var seen = true
  /// Whether a fade holds, as one under way does, until it's let go.
  var holding = false
  private var held: CheckedContinuation<Void, Never>?

  var doing: Fading.Doing {
    Fading.Doing(
      wait: { delay in self.waits.append(delay) },
      fade: {
        self.fades += 1
        self.seen = false
        if self.holding { await withCheckedContinuation { self.held = $0 } }
        // As the panel does, it puts the card away only when the fade wasn't stopped.
        if !Task.isCancelled { self.closes += 1 }
      },
      keep: { self.seen = true }
    )
  }

  /// Lets a fade under way end.
  func letGo() {
    held?.resume()
    held = nil
  }
}

/// The panel keeps a card up while yapd talks about it, even one that went up after it started, and fades it a while after, or a
/// while after it's shown when nothing's said of it.
@MainActor func checkFading() async {
  // Fetched once yapd had started talking about it, as when the app follows a state that points at it and says yapd is speaking,
  // which the panel hears before the card is up: it stays up until yapd stops, however long that takes, then lingers.
  do {
    let faded = Faded()
    let fading = Fading(faded.doing)
    let following = Following(Following.Doing(
      fetch: { id in Card(id: id, kind: "said", title: "What I said", markdown: "### I said\n\nOne running.", url: nil, caption: nil) },
      show: { _, talking in fading.shown(talking: talking) },
      hide: { fading.hidden() },
      takeDown: { _ in },
      wait: { _ in }
    ))
    following.follow(pointing("c1", fresh: true), connecting: false)
    fading.heard(speaking: true)
    await following.settled()
    await fading.settled()
    check(faded.fades == 0 && faded.waits.isEmpty, "keeps up a card yapd started talking about before it went up, not fading it after \(faded.waits)")
    fading.heard(speaking: false)
    await fading.settled()
    check(faded.fades == 1 && faded.waits == [.seconds(20)], "fades a card a while after yapd stops talking about it, not after \(faded.waits)")
  }

  // Up before yapd starts talking about it, it stays up until yapd stops.
  do {
    let faded = Faded()
    let fading = Fading(faded.doing)
    fading.shown(talking: true)
    fading.heard(speaking: true)
    await fading.settled()
    check(faded.fades == 0, "keeps up a card while yapd talks about it")
    fading.heard(speaking: false)
    await fading.settled()
    check(faded.fades == 1 && faded.waits.last == .seconds(20), "fades a card a while after yapd stops talking about it, not after \(faded.waits)")
  }

  // Never talked about after all, it lingers as if it had been.
  do {
    let faded = Faded()
    let fading = Fading(faded.doing)
    fading.shown(talking: true)
    await fading.settled()
    check(faded.fades == 1 && faded.waits == [.seconds(5), .seconds(20)], "fades a card yapd never talks about a while after, not after \(faded.waits)")
  }

  // Shown again with nothing said of it, it lingers, even while yapd is speaking of something else.
  do {
    let faded = Faded()
    let fading = Fading(faded.doing)
    fading.heard(speaking: true)
    fading.shown(talking: false)
    await fading.settled()
    check(faded.fades == 1 && faded.waits == [.seconds(20)], "fades a card shown with nothing said a while after, not after \(faded.waits)")
  }

  // Taken away while yapd talks about it, it's gone: what yapd says after doesn't have it fade.
  do {
    let faded = Faded()
    let fading = Fading(faded.doing)
    fading.heard(speaking: true)
    fading.shown(talking: true)
    fading.hidden()
    fading.heard(speaking: false)
    await fading.settled()
    check(faded.fades == 0, "leaves a card taken away to stay away, not fading it after \(faded.waits)")
  }

  // yapd's state stops coming in while it talks about the card, and comes back before the card fades, still talking: the card stays up
  // until yapd stops, then lingers.
  do {
    let faded = Faded()
    let fading = Fading(faded.doing)
    fading.shown(talking: true)
    fading.heard(speaking: true)
    fading.away()
    fading.heard(speaking: true)
    await fading.settled()
    check(faded.fades == 0, "keeps up a card yapd is still talking about once its state comes back, not fading it after \(faded.waits)")
    fading.heard(speaking: false)
    await fading.settled()
    check(faded.fades == 1 && faded.waits.last == .seconds(20), "fades a card a while after yapd stops talking about it, not after \(faded.waits)")
  }

  // Back still talking once the card lingered and started fading: it's shown in full again, and stays up until yapd stops.
  do {
    let faded = Faded()
    faded.holding = true
    let fading = Fading(faded.doing)
    fading.shown(talking: true)
    fading.heard(speaking: true)
    fading.away()
    while faded.fades == 0 { await Task.yield() }
    fading.heard(speaking: true)
    faded.letGo()
    await fading.settled()
    check(faded.fades == 1 && faded.closes == 0 && faded.seen, "shows a card yapd is still talking about once its state comes back as it fades, not leaving it unseen")
    faded.holding = false
    fading.heard(speaking: false)
    await fading.settled()
    check(faded.fades == 2 && !faded.seen && faded.waits.last == .seconds(20), "fades a card a while after yapd stops talking about it, not after \(faded.waits)")
  }

  // Gone while yapd talks about the card, and not back, or back with nothing said: it lingers once, from when the state stopped.
  for back in [false, true] {
    let faded = Faded()
    let fading = Fading(faded.doing)
    fading.heard(speaking: true)
    fading.shown(talking: true)
    fading.away()
    if back { fading.heard(speaking: false) }
    await fading.settled()
    check(faded.fades == 1 && faded.waits == [.seconds(20)], "fades a card once a while after yapd's state stopped, not after \(faded.waits)")
  }
}
