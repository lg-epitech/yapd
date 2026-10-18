import AppIntents

// What the Action button, the control, the Live Activity and Shortcuts run.
// They run in the app, which records, so the widgets only name them.

/// Starts dictating to yapd, or sends what was said, as the Mac's shortcut does. It records, which needs a Live Activity, which it starts.
struct TalkIntent: AudioRecordingIntent, LiveActivityIntent {
  static let title: LocalizedStringResource = "Talk to yapd"
  static let description = IntentDescription("Starts talking to yapd, or sends what you said.")

  func perform() async throws -> some IntentResult {
    #if YAPD_APP
      await Talk.shared.press()
    #endif
    return .result()
  }
}

/// Drops what's being dictated.
struct CancelIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Drop it"
  static let description = IntentDescription("Drops what you're dictating to yapd.")

  func perform() async throws -> some IntentResult {
    #if YAPD_APP
      await Talk.shared.cancel()
    #endif
    return .result()
  }
}
