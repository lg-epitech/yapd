import AppIntents

/// So "Talk to yapd" is there for the Action button and Siri without setting anything up.
struct Shortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(intent: TalkIntent(), phrases: ["Talk to \(.applicationName)"], shortTitle: "Talk", systemImageName: "waveform")
  }
}
