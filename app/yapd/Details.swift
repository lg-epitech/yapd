import Foundation

// What the panel beside a recent thread shows of it: what its row has, at
// once, and what `GET /threads/{key}` tells, once it comes, apart from AppKit
// and SwiftUI, so that app/checks can build it with swiftc on its own and
// check it. The menu bar only lays it out.

/// What `GET /threads/{key}` returns of a thread.
struct Details: Decodable, Equatable {
  /// Its latest pull request, as `/threads` has it.
  struct PullRequest: Decodable, Equatable {
    let number: Int
    /// Only ever an https address from T3 Code, and missing when T3 Code's isn't.
    let url: String?
    let state: String?
    let checks: String?
    let review: String?
    let mergeability: String?

    private enum CodingKeys: String, CodingKey { case number, url, state, checks, review, mergeability }

    init(number: Int, url: String? = nil, state: String? = nil, checks: String? = nil, review: String? = nil, mergeability: String? = nil) {
      self.number = number
      self.url = url
      self.state = state
      self.checks = checks
      self.review = review
      self.mergeability = mergeability
    }

    init(from decoder: Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      number = try container.decode(Int.self, forKey: .number)
      url = try? container.decodeIfPresent(String.self, forKey: .url)
      state = try? container.decodeIfPresent(String.self, forKey: .state)
      checks = try? container.decodeIfPresent(String.self, forKey: .checks)
      review = try? container.decodeIfPresent(String.self, forKey: .review)
      mergeability = try? container.decodeIfPresent(String.self, forKey: .mergeability)
    }

    /// Where it's opened in the browser: only an https page, as a card's links are, and none otherwise.
    var address: URL? {
      url.flatMap(URL.init(string:)).flatMap { opens($0) ? $0 : nil }
    }
  }

  /// One of its updates or notices, or a message passed on to it for him.
  struct Told: Decodable, Equatable, Identifiable {
    enum Kind: String, Decodable { case update, notice, sent }

    let id: Int
    /// ISO 8601.
    let at: String
    let kind: Kind
    /// All of what yapd said or kept of an update or notice, what it keeps for "more" too.
    let said: String?
    /// His words, as yapd passed them on.
    let text: String?
    /// ISO 8601, when he heard it through.
    let heard: String?

    init(id: Int, at: String, kind: Kind, said: String? = nil, text: String? = nil, heard: String? = nil) {
      self.id = id
      self.at = at
      self.kind = kind
      self.said = said
      self.text = text
      self.heard = heard
    }
  }

  let key: String
  let machine: String
  /// T3 Code's id for it, or none for a session yapd can't tie to a thread.
  let thread: String?
  /// What it's doing, as `/threads` has it, only while yapd can see it in T3 Code.
  let state: String?
  /// ISO 8601, when it got to that state.
  let since: String?
  let branch: String?
  let pr: PullRequest?
  let muted: Bool
  /// ISO 8601, when the mute ends on its own, if it does.
  let until: String?
  /// The latest of what was told of it and sent to it for him, newest first.
  let updates: [Told]

  private enum CodingKeys: String, CodingKey { case key, machine, thread, state, since, branch, pr, muted, until, updates }

  init(
    key: String, machine: String, thread: String? = nil, state: String? = nil, since: String? = nil, branch: String? = nil,
    pr: PullRequest? = nil, muted: Bool = false, until: String? = nil, updates: [Told] = []
  ) {
    self.key = key
    self.machine = machine
    self.thread = thread
    self.state = state
    self.since = since
    self.branch = branch
    self.pr = pr
    self.muted = muted
    self.until = until
    self.updates = updates
  }

  /// What the app can't read of it is left out, rather than all of it: a pull request, or one of the updates, of a kind it
  /// doesn't know or missing what it needs.
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    key = try container.decode(String.self, forKey: .key)
    machine = try container.decode(String.self, forKey: .machine)
    thread = try? container.decodeIfPresent(String.self, forKey: .thread)
    state = try? container.decodeIfPresent(String.self, forKey: .state)
    since = try? container.decodeIfPresent(String.self, forKey: .since)
    branch = try? container.decodeIfPresent(String.self, forKey: .branch)
    pr = try? container.decodeIfPresent(PullRequest.self, forKey: .pr)
    muted = (try? container.decodeIfPresent(Bool.self, forKey: .muted)) ?? false
    until = try? container.decodeIfPresent(String.self, forKey: .until)
    updates = ((try? container.decodeIfPresent([Lenient<Told>].self, forKey: .updates)) ?? []).compactMap(\.value)
  }

  /// What yapd's answer says, `body` and `response` as they came back: none when it doesn't know the thread, as a yapd from
  /// before it says of every one, when the key isn't one it makes, and when it didn't answer with them.
  init?(_ body: Data, _ response: URLResponse) {
    guard (response as? HTTPURLResponse)?.statusCode == 200, let details = try? JSONDecoder().decode(Details.self, from: body) else { return nil }
    self = details
  }
}

/// What the card at the top of a recent thread's panel shows: what its row has, at once, and the rest once yapd's details of it
/// come, unless yapd doesn't know it or is too old to tell, when the row's is all there is.
struct Glance: Equatable {
  /// What a thread is doing, as the colour of the dot beside it says it.
  enum Tone: Equatable {
    case busy, waiting, failed, limited, still
  }

  /// What it's doing, like "Running · 12 min".
  struct Doing: Equatable {
    let line: String
    let tone: Tone
  }

  /// One of what was told of it, or sent to it.
  struct Told: Equatable, Identifiable {
    let id: String
    /// How long ago, like "3 min ago".
    let when: String
    let text: String
    /// Whether it's an update or notice he hasn't heard through, unknown for what the row has of it.
    let unheard: Bool?
  }

  let title: String
  /// Its project and its machine.
  let place: String
  /// None while yapd can't see it in T3 Code, and for a session.
  let doing: Doing?
  let branch: String?
  /// Its pull request, like "#412 · open · checks passing · approved".
  let pr: String?
  /// "Muted", or "Muted until 3:00 PM", none when it isn't.
  let muted: String?
  /// How many of its updates he hasn't heard, like "2 unheard", only when it isn't muted.
  let unheard: String?
  /// Its latest update or notice, all of it.
  let latest: Told?
  /// Up to four of what came before it, updates, notices and what he sent it, newest first.
  let earlier: [Told]

  /// The card for `row`, with yapd's `details` of it once they come, its times told from `now`, in his time.
  init(_ row: Status.Recent, details: Details?, now: Date, zone: TimeZone = .current, locale: Locale = .current) {
    title = row.title
    place = [row.project?.name, row.machine].compactMap { $0 }.joined(separator: " · ")
    doing = details.flatMap { details in details.state.map { Glance.doing($0, since: details.since.flatMap(Status.date), now: now) } }
    branch = details?.branch.flatMap { $0.isEmpty ? nil : $0 }
    pr = details?.pr.map(Glance.pr)
    // The row's, which the state keeps up to date while the menu is open.
    muted = row.muted ? row.until.flatMap(Status.date).map { "Muted until \(clock($0, now: now, zone: zone, locale: locale))" } ?? "Muted" : nil
    unheard = row.unheard > 0 && !row.muted ? "\(row.unheard) unheard" : nil
    let told = (details?.updates ?? []).compactMap { Glance.told($0, now: now) }
    // The latest update or notice, else what the row says of it, with nothing on whether he heard it.
    if let latest = told.firstIndex(where: { $0.said }) {
      self.latest = told[latest].told
      earlier = Array(told.enumerated().filter { $0.offset != latest }.map(\.element.told).prefix(4))
    } else {
      let when = row.ended.map { ago($0, now: now) } ?? ""
      latest = row.text.isEmpty ? nil : Told(id: "row", when: when, text: row.text, unheard: nil)
      earlier = Array(told.map(\.told).prefix(4))
    }
  }

  /// What's said over the latest: how long ago it was told, and whether he heard it, when that's known, like "3 min ago ·
  /// unheard".
  var heard: String? {
    guard let latest else { return nil }
    let parts = [latest.when, latest.unheard.map { $0 ? "unheard" : "heard" } ?? ""].filter { !$0.isEmpty }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  /// One of what was told of it, with whether it was said, rather than sent, or none with nothing to show.
  private static func told(_ told: Details.Told, now: Date) -> (told: Told, said: Bool)? {
    let when = Status.date(told.at).map { ago($0, now: now) } ?? ""
    switch told.kind {
    case .update, .notice:
      guard let said = told.said, !said.isEmpty else { return nil }
      return (Told(id: String(told.id), when: when, text: said, unheard: told.heard == nil), true)
    case .sent:
      guard let text = told.text, !text.isEmpty else { return nil }
      return (Told(id: String(told.id), when: when, text: "You: \(text)", unheard: false), false)
    }
  }

  /// What a thread is doing, as `/threads` has its state, and for how long, or since when it's idle, told from `now`.
  static func doing(_ state: String, since: Date?, now: Date) -> Doing {
    switch state {
    case "running":
      return Doing(line: "Running\(since.map { " · \(lasted($0, now: now))" } ?? "")", tone: .busy)
    case "approval": return Doing(line: "Waiting on you · an approval", tone: .waiting)
    case "question": return Doing(line: "Waiting on you · a question", tone: .waiting)
    case "finishing": return Doing(line: "Finishing", tone: .busy)
    case "queued": return Doing(line: "Queued", tone: .still)
    case "failed": return Doing(line: "Failed", tone: .failed)
    case "limited": return Doing(line: "Hit a usage limit", tone: .limited)
    case "idle":
      let when = since.map { ago($0, now: now) }
      return Doing(line: when.map { $0 == "now" ? "Idle · just now" : "Idle · since \($0)" } ?? "Idle", tone: .still)
    default:
      // One the app doesn't know, in yapd's words.
      let words = plainly(state)
      return Doing(line: words.prefix(1).uppercased() + words.dropFirst(), tone: .still)
    }
  }

  /// A pull request in a line, like "#412 · open · checks passing · approved": its state, its checks, its review, and whether
  /// it has conflicts while it's open, as T3 Code words them.
  static func pr(_ pr: Details.PullRequest) -> String {
    let reviews = ["approved": "approved", "changes-requested": "changes requested", "review-required": "waiting for a review"]
    var parts = ["#\(pr.number)"]
    if let state = pr.state { parts.append(plainly(state)) }
    if let checks = pr.checks { parts.append("checks \(plainly(checks))") }
    if let review = pr.review { parts.append(reviews[review] ?? plainly(review)) }
    if pr.state == "open" && pr.mergeability == "conflicting" { parts.append("conflicts") }
    return parts.joined(separator: " · ")
  }

  /// How long something has been going, like "12 min", "2 h 5 min" or "3 days".
  static func lasted(_ since: Date, now: Date) -> String {
    let minutes = Int(now.timeIntervalSince(since) / 60)
    switch minutes {
    case ..<1: return "under a minute"
    case ..<60: return "\(minutes) min"
    case ..<(24 * 60): return minutes % 60 == 0 ? "\(minutes / 60) h" : "\(minutes / 60) h \(minutes % 60) min"
    case ..<(48 * 60): return "1 day"
    default: return "\(minutes / (24 * 60)) days"
    }
  }

  /// A word as T3 Code has it, in lower case, with spaces for its dashes and underscores.
  private static func plainly(_ word: String) -> String {
    word.lowercased().replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ")
  }
}
