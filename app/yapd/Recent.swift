import Foundation

// What the menu shows of the threads with the latest updates, and what it asks
// yapd about them, apart from AppKit and SwiftUI, so that app/checks can build
// it with swiftc on its own and check it.

extension Status.Recent {
  /// How the menu names it: its project, then its title, cut short when it's long.
  var label: String {
    let named = project.map { "\($0.name) · \(title)" } ?? title
    return named.count > 60 ? "\(named.prefix(59))…" : named
  }

  /// What the menu says under it: how long ago its turn ended, whether it waits on him, how many of its updates he hasn't
  /// heard unless it's muted, and whether it's muted.
  func detail(now: Date) -> String {
    var parts: [String] = []
    if let ended { parts.append(ago(ended, now: now)) }
    if waiting { parts.append("waiting on you") }
    if unheard > 0 && !muted { parts.append("\(unheard) unheard") }
    if muted { parts.append("muted") }
    return parts.joined(separator: " · ")
  }

  /// Whether the menu lets him hear it again: only while yapd is on, and only a row yapd can say again. Muting it works
  /// either way.
  func hearable(on: Bool) -> Bool {
    on && replayable
  }

  /// The monogram to draw when its icon can't be, as T3 Code draws a project: the one the icon carries, else one made from
  /// the project's name. None for a row with no project.
  var monogram: Status.Monogram? {
    project.flatMap { $0.icon?.instead ?? Status.Monogram(of: $0.name) }
  }
}

/// How long ago something happened, as the menu says it: "now", "3 min ago", "2 h ago", "yesterday", then in days.
func ago(_ at: Date, now: Date) -> String {
  let minutes = Int(now.timeIntervalSince(at) / 60)
  switch minutes {
  case ..<1: return "now"
  case ..<60: return "\(minutes) min ago"
  case ..<(24 * 60): return "\(minutes / 60) h ago"
  case ..<(48 * 60): return "yesterday"
  default: return "\(minutes / (24 * 60)) days ago"
  }
}

extension Status.Monogram {
  /// The monogram T3 Code makes from a project's name, as yapd does: its first letter, and the first number after it in the
  /// first word, else the first letter of the last word, else the first word's last letter; and a colour from the name.
  init(of name: String) {
    let normalized = name.precomposedStringWithCompatibilityMapping.trimmingCharacters(in: .whitespacesAndNewlines)
    // Runs of letters and numbers, by code point, as T3 Code's /[\p{L}\p{N}]+/gu finds them.
    var words: [[Unicode.Scalar]] = []
    var word: [Unicode.Scalar] = []
    for scalar in normalized.unicodeScalars {
      if scalar.isLetterOrNumber {
        word.append(scalar)
      } else if !word.isEmpty {
        words.append(word)
        word = []
      }
    }
    if !word.isEmpty { words.append(word) }
    var text = "PR"
    if let first = words.first, let lead = first.first {
      let next = first.dropFirst().first(where: \.isNumber) ?? (words.count > 1 ? words[words.count - 1].first : first.last) ?? lead
      var both = String.UnicodeScalarView()
      both.append(lead)
      both.append(next)
      text = String(String.UnicodeScalarView(String(both).uppercased().unicodeScalars.prefix(2)))
    }
    var hash: UInt32 = 0
    let lowered = normalized.lowercased(with: Locale(identifier: "en-US"))
    for scalar in (lowered.isEmpty ? "project" : lowered).unicodeScalars {
      hash = (hash * 31 + scalar.value) % UInt32(Tint.all.count)
    }
    self.init(text: text, color: Tint.all[Int(hash)].name)
  }
}

extension Unicode.Scalar {
  /// A letter, \p{L}, or a number, \p{N}.
  fileprivate var isLetterOrNumber: Bool { isNumber || Self.letters.contains(properties.generalCategory) }

  /// A number, \p{N}.
  fileprivate var isNumber: Bool {
    [.decimalNumber, .letterNumber, .otherNumber].contains(properties.generalCategory)
  }

  private static let letters: Set<Unicode.GeneralCategory> = [.uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter]
}

/// One of T3 Code's colours, as it draws a monogram in it: the text in Tailwind's 600 shade, or 400 in dark mode, on the
/// same colour at 14%.
struct Tint: Equatable {
  let name: String
  /// sRGB, as 0xRRGGBB.
  let light: UInt32
  let dark: UInt32

  /// T3 Code's colours, in its order, which is what a name's monogram is coloured by.
  static let all: [Tint] = [
    Tint(name: "gray", light: 0x4A5565, dark: 0x99A1AF),
    Tint(name: "red", light: 0xE7000B, dark: 0xFF6467),
    Tint(name: "orange", light: 0xF54900, dark: 0xFF8904),
    Tint(name: "amber", light: 0xE17100, dark: 0xFFB900),
    Tint(name: "yellow", light: 0xD08700, dark: 0xFDC700),
    Tint(name: "lime", light: 0x5EA500, dark: 0x9AE600),
    Tint(name: "green", light: 0x00A63E, dark: 0x05DF72),
    Tint(name: "emerald", light: 0x009966, dark: 0x00D492),
    Tint(name: "teal", light: 0x009689, dark: 0x00D5BE),
    Tint(name: "cyan", light: 0x0092B8, dark: 0x00D3F2),
    Tint(name: "sky", light: 0x0084D1, dark: 0x00BCFF),
    Tint(name: "blue", light: 0x155DFC, dark: 0x51A2FF),
    Tint(name: "indigo", light: 0x4F39F6, dark: 0x7C86FF),
    Tint(name: "violet", light: 0x7F22FE, dark: 0xA684FF),
    Tint(name: "purple", light: 0x9810FA, dark: 0xC27AFF),
    Tint(name: "fuchsia", light: 0xC800DE, dark: 0xED6AFF),
    Tint(name: "pink", light: 0xE60076, dark: 0xFB64B6),
    Tint(name: "rose", light: 0xEC003F, dark: 0xFF637E),
  ]

  /// The colour by its name, or none for one T3 Code doesn't have, which is drawn in the menu's own text colour.
  static func named(_ name: String) -> Tint? {
    all.first { $0.name == name }
  }
}

/// A request about one of the recent threads, by its key, percent-encoded as one piece of the path.
protocol Asking {
  var method: String { get }
  /// Relative to yapd's API.
  var path: String { get }
  /// JSON, for a request that's sent one.
  var body: Data? { get }
}

extension Asking {
  /// The address on yapd's API at `api`, with the key kept as it's encoded.
  func url(at api: URL) -> URL? {
    URL(string: path, relativeTo: api)?.absoluteURL
  }

  var body: Data? { nil }
}

/// A thread's key as one piece of a path: everything but what's never encoded is.
func encoded(_ key: String) -> String {
  var unreserved = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
  unreserved.insert(charactersIn: "-._~")
  return key.addingPercentEncoding(withAllowedCharacters: unreserved) ?? key
}

/// Muting a thread, as `PUT /threads/{key}/mute`, until he takes it off or until a time, or taking it off, as `DELETE`.
struct Muting: Asking, Equatable {
  let key: String
  let on: Bool
  /// When the mute ends on its own, if it does.
  let until: Date?

  init(_ row: Status.Recent, on: Bool, until: Date? = nil) {
    key = row.key
    self.on = on
    self.until = on ? until : nil
  }

  /// Muting it for an hour from `now`, after which yapd takes the mute off on its own.
  static func forAnHour(_ row: Status.Recent, from now: Date) -> Muting {
    Muting(row, on: true, until: now.addingTimeInterval(60 * 60))
  }

  var method: String { on ? "PUT" : "DELETE" }
  var path: String { "threads/\(encoded(key))/mute" }

  /// `{"until": …}` in ISO 8601, as yapd reads it, for a mute that ends on its own; none for one that lasts until he takes it
  /// off, and to take it off.
  var body: Data? {
    guard let until else { return nil }
    let format = ISO8601DateFormatter()
    format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return try? JSONEncoder().encode(["until": format.string(from: until)])
  }
}

/// Having a thread's subagents read to him from now on, as `PUT /threads/{key}/subagents`, or kept to yapd again, as `DELETE`: a
/// subagent's row by the key of the thread it's part of, whose subagents they are, never its own, which yapd turns away.
struct Subagents: Asking, Equatable {
  let key: String
  let on: Bool

  init(_ row: Status.Recent, on: Bool) {
    key = row.head?.key ?? row.key
    self.on = on
  }

  var method: String { on ? "PUT" : "DELETE" }
  var path: String { "threads/\(encoded(key))/subagents" }
}

/// Hearing a thread's latest update again, as `POST /threads/{key}/replay`.
struct Replaying: Asking, Equatable {
  let key: String

  init(_ row: Status.Recent) {
    key = row.key
  }

  var method: String { "POST" }
  var path: String { "threads/\(encoded(key))/replay" }
}

/// Asking what yapd tells of a thread for its panel, as `GET /threads/{key}`.
struct Detailing: Asking, Equatable {
  let key: String

  init(_ row: Status.Recent) {
    key = row.key
  }

  var method: String { "GET" }
  var path: String { "threads/\(encoded(key))" }
}

/// Where a project's image is fetched from: the path yapd gave, on yapd's own API, and never anywhere else, nor with a query.
func imageAddress(_ path: String, at api: URL) -> URL? {
  guard path.hasPrefix("/"), !path.hasPrefix("//"), !path.contains("?"), !path.contains("#"), !path.contains("\\") else { return nil }
  guard let url = URL(string: path, relativeTo: api)?.absoluteURL,
    url.scheme == api.scheme, url.host == api.host, url.port == api.port
  else { return nil }
  return url
}
