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
    /// The revision yapd put it up or back up at, this time, which a request to take it down is sent with, so it's taken down
    /// only as it was up then. None from a yapd too old to tell one time a card went up from another.
    let revision: Int?

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
  /// How many times yapd put a card up or took one down, or was asked to take one down, which a card asked to go back up is
  /// sent with, so it goes back up only if nothing came since. None from a yapd too old to count them.
  let revision: Int?

  private enum CodingKeys: String, CodingKey { case on, activity, updates, showing, revision }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    on = try container.decode(Bool.self, forKey: .on)
    activity = try container.decode(String.self, forKey: .activity)
    updates = try container.decode([Update].self, forKey: .updates)
    // An older yapd doesn't send them at all.
    showing = try container.decodeIfPresent(Showing.self, forKey: .showing)
    revision = try container.decodeIfPresent(Int.self, forKey: .revision)
  }
}

/// What `DELETE /cards/current` is sent to take a card down: the card, and the revision it went up at as the state followed last
/// said, so yapd takes it down only while it's still up as it went up then, and a request that gets there late never takes down
/// the same card put back up since. Without one, as when yapd is too old to tell, it takes the card down whichever time it went up.
struct TakeDown: Equatable {
  let id: String
  let shown: Int?

  /// As the request asks it.
  var query: [URLQueryItem] {
    [URLQueryItem(name: "id", value: id)] + (shown.map { [URLQueryItem(name: "shown", value: String($0))] } ?? [])
  }
}

/// What `PUT /cards/current` is sent to put a card back up: the card, and the revision of the state followed last as it was
/// asked for, so yapd puts it back up only if nothing came since. Without one, as when yapd is too old to count, it goes back up
/// whatever came since.
struct PutBack: Encodable, Equatable {
  let id: String
  let revision: Int?
}

/// What came of fetching one of the cards yapd showed lately, from `GET /cards/{id}`.
enum Fetched: Equatable {
  case card(Card)
  /// yapd said it no longer has it, after twenty more or as it restarted since.
  case missing
  /// yapd didn't answer, or not with the card, which says nothing of whether it still has it.
  case failed

  /// What yapd's answer says, `body` and `response` as they came back.
  init(_ body: Data, _ response: URLResponse) {
    switch (response as? HTTPURLResponse)?.statusCode {
    case 200: self = (try? JSONDecoder().decode(Card.self, from: body)).map(Fetched.card) ?? .failed
    case 404: self = .missing
    default: self = .failed
    }
  }
}

/// The card the panel shows, following the one yapd points at: put up once it's fetched, which is tried again a few times, a
/// while apart, as long as yapd still points at it, and taken away when yapd takes it down. What yapd points at is only what
/// it asks for, so on connecting, even to the same card, it's checked against what the panel actually shows, which may have
/// faded while yapd was away. A card shown again from the menu is fetched too, and shown only if nothing newer came meanwhile,
/// and yapd puts it back up only if nothing came there since the state followed last as it was asked for. A card is taken down
/// at yapd as it went up the time the panel follows, so a request for a card put away that gets there late never takes it down
/// once it's been put back up since.
@MainActor
final class Following {
  /// What it does with the panel, and asks of yapd.
  struct Doing {
    /// One of the cards yapd showed lately, unless yapd no longer has it or fetching it fails.
    let fetch: @MainActor (String) async -> Fetched
    /// Puts a card up, `talking` when yapd is about to talk about it.
    let show: @MainActor (Card, _ talking: Bool) -> Void
    /// Takes the card away at once.
    let hide: @MainActor () -> Void
    /// Has yapd take this card down too, as `DELETE /cards/current?id=&shown=`, which it does only while it's still the one up,
    /// as it went up then, so a request that gets there late never takes down a card put up since, nor the same one put back up.
    let takeDown: @MainActor (TakeDown) -> Void
    /// Has yapd put a card back up, as `PUT /cards/current`, so it points at it again and "hide that" takes it down, unless
    /// something came since the revision it's sent with: a request that gets there late never undoes it. Done once yapd
    /// answers, and stopped, unless it's gone already, when the card is superseded first.
    let putBack: @MainActor (PutBack) async -> Void
    /// Waits before trying again.
    let wait: @MainActor (Duration) async -> Void
  }

  /// How long it waits before each time it tries fetching a card again, once fetching it failed.
  static let retries: [Duration] = [.seconds(1), .seconds(2), .seconds(4)]

  private let doing: Doing
  /// The card yapd points at, as its state said last.
  private(set) var wanted: String?
  /// The revision that card went up at, as its state said last, or will once yapd puts back up a card shown again, which it's
  /// taken down at.
  private(set) var since: Int?
  /// The card the panel shows, from when it's put up until it's taken away or goes away on its own.
  private(set) var shown: String?
  /// yapd's revision, as its state said last.
  private(set) var revision: Int?
  /// Whether yapd's state is coming in, so yapd can be told what the panel does.
  private var connected = false
  /// A card the panel put away while yapd was away, so wasn't told.
  private var untold: String?
  /// Fetching the card yapd points at to put it up, which stops when it points at another.
  private var putting: Task<Void, Never>?
  /// Fetching the card asked last to be shown again, which stops when anything newer comes first.
  private var replaying: Task<Void, Never>?
  /// How many times the panel was told something newer than a card being fetched to show again, so one whose fetch comes back
  /// after that, even had it missed being stopped, is left unshown.
  private var newer = 0

  init(_ doing: Doing) {
    self.doing = doing
  }

  /// Follows yapd's state as it comes in, the card it points at and its revision: `connecting` for the first since it was away.
  func follow(_ showing: Status.Showing?, revision: Int?, connecting: Bool) {
    connected = true
    let untold = self.untold
    self.untold = nil
    // A card put up or taken down at yapd, or asked to be taken down, even with the same one up or none, comes after a card
    // asked to be shown again before, which yapd wouldn't put back up now anyway.
    let moved = revision != self.revision
    if moved { supersede() }
    self.revision = revision
    // The same card put back up since, as by another app, is up anew. Only a state at another revision can say so: until then,
    // a card shown again from the menu is taken to be up at the revision it's to be put back up at.
    guard connecting || showing?.id != wanted || (moved && showing?.revision != since) else { return }
    // What yapd says is up now comes after a card asked to be shown again before, so that one isn't.
    supersede()
    wanted = showing?.id
    since = showing?.revision
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
      return doing.takeDown(TakeDown(id: showing.id, shown: showing.revision))
    }
    putting = Task { await put(showing.id) }
  }

  /// yapd's state stopped coming in: what the panel puts away meanwhile, it's told of once it's back.
  func away() {
    connected = false
  }

  /// The panel put a card away, by its close button or by fading: yapd takes it down too, unless it points at another since.
  func closed(_ id: String) {
    // Put away since it was asked for, the panel isn't to be put back up by a card shown again late.
    supersede()
    if shown == id { shown = nil }
    guard wanted == id else { return }
    if connected { doing.takeDown(TakeDown(id: id, shown: since)) } else { untold = id }
  }

  /// Fetches one of the cards yapd showed lately and shows it again, with nothing said of it, and has yapd put it back up too,
  /// unless yapd points at another, puts one up or takes one down, or connects, or a card is put away, before it's fetched: what
  /// came last wins, so a fetch that comes back late never replaces a card put up since or undoes a hide. yapd is asked at the
  /// revision of the state followed last, so its request, getting there late, never does either. `gone` when yapd says it no
  /// longer has it; when fetching it fails, as while yapd is slow or restarting, nothing shows, and it can be asked for again.
  func showAgain(_ id: String, gone: @escaping @MainActor () -> Void) {
    supersede()
    let asked = newer
    let revision = self.revision
    replaying = Task {
      let fetched = await doing.fetch(id)
      // Stopped, a fetch that failed only for that says nothing of whether yapd still has it.
      guard !Task.isCancelled, asked == newer else { return }
      let card: Card
      switch fetched {
      case .card(let fetched): card = fetched
      case .missing: return gone()
      case .failed: return
      }
      putting?.cancel()
      putting = nil
      wanted = card.id
      // yapd puts it back up at the revision after the one it's asked at, which is the one its state says it went up at once it
      // has, so a request to take it down, even put away before that state comes, names it as it's up then: a request for when
      // it was up before, getting there late, leaves it up.
      since = revision.map { $0 + 1 }
      shown = card.id
      doing.show(card, false)
      await doing.putBack(PutBack(id: card.id, revision: revision))
    }
  }

  /// Once the card being fetched is put up, or given up on, and the one fetched last to show again has come back, shown or not,
  /// with yapd's answer to putting it back up.
  func settled() async {
    await putting?.value
    await replaying?.value
  }

  /// Stops showing again a card still being fetched for it, as the panel was told something newer.
  private func supersede() {
    newer += 1
    replaying?.cancel()
  }

  /// Fetches the card and puts it up, trying again a few times, a while apart, as long as yapd points at it.
  private func put(_ id: String) async {
    for wait in [nil] + Self.retries.map(Optional.some) {
      if let wait { await doing.wait(wait) }
      guard !Task.isCancelled, wanted == id else { return }
      // Tried again even when yapd says it no longer has it, only for as long as yapd points at it, which it stops doing then.
      if case .card(let card) = await doing.fetch(id) {
        guard !Task.isCancelled, wanted == id else { return }
        shown = id
        return doing.show(card, true)
      }
    }
    // Given up on, it isn't on screen, so yapd takes it down too, and it's kept to show again.
    guard !Task.isCancelled, wanted == id else { return }
    doing.takeDown(TakeDown(id: id, shown: since))
  }
}
