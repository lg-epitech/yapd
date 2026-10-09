import Foundation

// When the panel's card fades, apart from AppKit and SwiftUI, so that
// app/checks can build it with swiftc on its own and check it. The panel only
// fades it when it's told to.

/// When the card on the panel fades: a while after yapd stops talking about it, or after it's shown with nothing said of it.
/// Whether yapd is speaking is kept as its state comes in, with a card up or not, since a card that has to be fetched first goes
/// up after yapd started talking about it, and must stay up until that's done all the same.
@MainActor
final class Fading {
  /// What it does with the panel.
  struct Doing {
    /// Waits before the card fades.
    let wait: @MainActor (Duration) async -> Void
    /// Fades the card away, and puts it away, unless another went up or it was kept meanwhile.
    let fade: @MainActor () async -> Void
    /// Keeps the card up after all: stops it fading, if it was, and shows it fully again.
    let keep: @MainActor () -> Void
  }

  /// How long a card stays up once yapd stops talking about it, or after it's shown with nothing said.
  static let linger: Duration = .seconds(20)
  /// How long a card that yapd is about to talk about waits for it to start, before it lingers as if it had.
  static let patience: Duration = .seconds(5)

  /// Where a card is in being talked about: not yet, now, done with, or unknown since yapd's state stopped coming in while it was.
  private enum Talk { case coming, talking, done, away }

  private let doing: Doing
  /// Where the card up is in being talked about, and done with while none is.
  private var talk = Talk.done
  /// Whether yapd is speaking, as its state said last.
  private var speaking = false
  /// Waiting for the card to fade, then fading it.
  private var fading: Task<Void, Never>?

  init(_ doing: Doing) {
    self.doing = doing
  }

  /// A card went up. `talking` is whether yapd is about to talk about it, which it fades a while after; otherwise it lingers.
  func shown(talking: Bool) {
    fading?.cancel()
    fading = nil
    // Fetched once yapd had started talking about it, it waits for that to end, not to start.
    talk = !talking ? .done : speaking ? .talking : .coming
    switch talk {
    case .coming: fade(after: Self.patience)
    case .talking, .away: break
    case .done: fade(after: Self.linger)
    }
  }

  /// Whether yapd is speaking now: the card up fades a while after yapd stops talking about it.
  func heard(speaking: Bool) {
    self.speaking = speaking
    switch talk {
    case .coming where speaking, .away where speaking:
      talk = .talking
      fading?.cancel()
      // Back while the card lingered, it may be fading already: cancelling that only stops it being put away, so it's shown in full again.
      doing.keep()
    case .talking where !speaking:
      talk = .done
      fade(after: Self.linger)
    case .away:
      // Back with nothing being said, it goes on lingering from when the state stopped coming in.
      talk = .done
    default:
      break
    }
  }

  /// yapd's state stopped coming in. A card it was talking about lingers as if it had finished, unless yapd is back, still talking,
  /// before it fades: then it stays up until yapd stops.
  func away() {
    speaking = false
    guard talk == .talking else { return }
    talk = .away
    fade(after: Self.linger)
  }

  /// The card was put away at once, so it no longer fades.
  func hidden() {
    talk = .done
    fading?.cancel()
  }

  /// Once the card has faded, or stopped waiting to.
  func settled() async {
    await fading?.value
  }

  private func fade(after delay: Duration) {
    fading?.cancel()
    fading = Task { [weak self] in
      guard let self else { return }
      await self.doing.wait(delay)
      guard !Task.isCancelled else { return }
      // Not yet talked about after all: it lingers as if it had been.
      if self.talk == .coming {
        self.talk = .done
        await self.doing.wait(Self.linger)
        guard !Task.isCancelled else { return }
      }
      await self.doing.fade()
    }
  }
}
