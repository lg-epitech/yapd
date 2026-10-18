import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct Widgets: WidgetBundle {
  var body: some Widget {
    TalkControl()
    TalkActivity()
  }
}

/// For the Action button, Control Center and the Lock Screen: press to talk to yapd, press again to send.
struct TalkControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: "dev.yapd.phone.talk") {
      ControlWidgetButton(action: TalkIntent()) {
        Label("Talk to yapd", systemImage: "waveform")
      }
    }
    .displayName("Talk to yapd")
    .description("Starts talking to yapd, or sends what you said.")
  }
}

/// What it says while the phone talks to yapd, with a button to send and one to drop it.
struct TalkActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: TalkAttributes.self) { context in
      HStack(spacing: 16) {
        Image(systemName: symbol(context.state.state))
          .font(.title2)
          .foregroundStyle(.cyan)
        Text(words(context.state.state))
          .font(.headline)
        Spacer()
        if context.state.state == "listening" {
          Button(intent: CancelIntent()) { Image(systemName: "xmark") }
            .tint(.gray)
          Button(intent: TalkIntent()) { Text("Send") }
            .tint(.cyan)
        } else {
          Button(intent: TalkIntent()) { Image(systemName: "mic.fill") }
            .tint(.cyan)
        }
      }
      .padding()
      .activityBackgroundTint(.black.opacity(0.8))
      .activitySystemActionForegroundColor(.cyan)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Image(systemName: symbol(context.state.state)).foregroundStyle(.cyan)
        }
        DynamicIslandExpandedRegion(.center) {
          Text(words(context.state.state))
        }
        DynamicIslandExpandedRegion(.trailing) {
          Button(intent: TalkIntent()) { Text(context.state.state == "listening" ? "Send" : "Talk") }
            .tint(.cyan)
        }
      } compactLeading: {
        Image(systemName: symbol(context.state.state)).foregroundStyle(.cyan)
      } compactTrailing: {
        Text(context.state.state == "listening" ? "Listening" : "")
      } minimal: {
        Image(systemName: symbol(context.state.state)).foregroundStyle(.cyan)
      }
    }
  }

  private func symbol(_ state: String) -> String {
    switch state {
    case "listening": "mic.fill"
    case "speaking": "speaker.wave.2.fill"
    case "connecting": "antenna.radiowaves.left.and.right"
    default: "waveform"
    }
  }

  private func words(_ state: String) -> String {
    switch state {
    case "listening": "Listening"
    case "speaking": "yapd"
    case "connecting": "Reaching yapd"
    default: "yapd"
    }
  }
}
