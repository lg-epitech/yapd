import Foundation

// What the app knows of yapd's state, and how the panel follows the card it
// points at, apart from AppKit and SwiftUI, so that app/checks can build them
// with swiftc on their own and check them.

/// What `GET /state` returns.
struct Status: Decodable {
  struct Update: Decodable, Identifiable {
    let id: String
    let text: String
  }

  /// The card yapd is showing, as `/state` points at it.
  struct Showing: Decodable, Equatable {
    let id: String
    /// ISO 8601, when yapd put it up.
    let at: String

    /// Whether it went up a moment ago, rather than before the app was watching.
    var fresh: Bool {
      let format = ISO8601DateFormatter()
      format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      guard let at = format.date(from: at) else { return false }
      return Date().timeIntervalSince(at) < 30
    }
  }

  let on: Bool
  let activity: String
  let updates: [Update]
  /// None when no card is up, and from a yapd too old to show cards.
  let showing: Showing?

  private enum CodingKeys: String, CodingKey { case on, activity, updates, showing }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    on = try container.decode(Bool.self, forKey: .on)
    activity = try container.decode(String.self, forKey: .activity)
    updates = try container.decode([Update].self, forKey: .updates)
    // An older yapd doesn't send it at all.
    showing = try container.decodeIfPresent(Showing.self, forKey: .showing)
  }
}

/// The card the panel shows, following the one yapd points at: put up once it's fetched, which is tried again a few times, a
/// while apart, as long as yapd still points at it, and taken away when yapd takes it down. What yapd points at is only what
/// it asks for, so on connecting, even to the same card, it's checked against what the panel actually shows, which may have
/// faded while yapd was away.
@MainActor
final class Following {
  /// What it does with the panel, and asks of yapd.
  struct Doing {
    /// One of the cards yapd showed lately, or none when that fails.
    let fetch: @MainActor (String) async -> Card?
    /// Puts a card up, `talking` when yapd is about to talk about it.
    let show: @MainActor (Card, _ talking: Bool) -> Void
    /// Takes the card away at once.
    let hide: @MainActor () -> Void
    /// Has yapd take this card down too, as `DELETE /cards/current?id=`, which it does only while it's still the one up, so a
    /// request that gets there late never takes down a card put up since.
    let takeDown: @MainActor (String) -> Void
    /// Waits before trying again.
    let wait: @MainActor (Duration) async -> Void
  }

  /// How long it waits before each time it tries fetching a card again, once fetching it failed.
  static let retries: [Duration] = [.seconds(1), .seconds(2), .seconds(4)]

  private let doing: Doing
  /// The card yapd points at, as its state said last.
  private(set) var wanted: String?
  /// The card the panel shows, from when it's put up until it's taken away or goes away on its own.
  private(set) var shown: String?
  /// Whether yapd's state is coming in, so yapd can be told what the panel does.
  private var connected = false
  /// A card the panel put away while yapd was away, so wasn't told.
  private var untold: String?
  /// Fetching the card yapd points at to put it up, which stops when it points at another.
  private var putting: Task<Void, Never>?

  init(_ doing: Doing) {
    self.doing = doing
  }

  /// Follows yapd's state as it comes in: `connecting` for the first since it was away.
  func follow(_ showing: Status.Showing?, connecting: Bool) {
    connected = true
    let untold = self.untold
    self.untold = nil
    guard connecting || showing?.id != wanted else { return }
    wanted = showing?.id
    putting?.cancel()
    putting = nil
    guard let showing else {
      shown = nil
      return doing.hide()
    }
    // Up already, as when yapd comes back before it faded.
    if shown == showing.id { return }
    if connecting && (!showing.fresh || showing.id == untold) {
      // Put up while the app wasn't there to show it, or put away since: it isn't on screen, so yapd takes it down too, and it's kept to show again.
      shown = nil
      doing.hide()
      return doing.takeDown(showing.id)
    }
    putting = Task { await put(showing.id) }
  }

  /// yapd's state stopped coming in: what the panel puts away meanwhile, it's told of once it's back.
  func away() {
    connected = false
  }

  /// The panel put a card away, by its close button or by fading: yapd takes it down too, unless it points at another since.
  func closed(_ id: String) {
    if shown == id { shown = nil }
    guard wanted == id else { return }
    if connected { doing.takeDown(id) } else { untold = id }
  }

  /// Shows a card fetched again, with nothing said of it, which yapd is asked to point at too.
  func showAgain(_ card: Card) {
    putting?.cancel()
    putting = nil
    wanted = card.id
    shown = card.id
    doing.show(card, false)
  }

  /// Once the card being fetched is put up, or given up on.
  func settled() async {
    await putting?.value
  }

  /// Fetches the card and puts it up, trying again a few times, a while apart, as long as yapd points at it.
  private func put(_ id: String) async {
    for wait in [nil] + Self.retries.map(Optional.some) {
      if let wait { await doing.wait(wait) }
      guard !Task.isCancelled, wanted == id else { return }
      if let card = await doing.fetch(id) {
        guard !Task.isCancelled, wanted == id else { return }
        shown = id
        return doing.show(card, true)
      }
    }
    // Given up on, it isn't on screen, so yapd takes it down too, and it's kept to show again.
    guard !Task.isCancelled, wanted == id else { return }
    doing.takeDown(id)
  }
}
