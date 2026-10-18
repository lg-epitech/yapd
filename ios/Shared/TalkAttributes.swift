import ActivityKit

/// What the Live Activity shows while the phone talks to yapd: connecting, ready, listening to a dictation, or speaking.
struct TalkAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var state: String
  }
}
