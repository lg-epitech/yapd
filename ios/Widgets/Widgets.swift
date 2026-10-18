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

/// What it says while the phone talks to yapd, with a round button to send and one to drop it, on the Lock Screen and in the Dynamic Island.
struct TalkActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: TalkAttributes.self) { context in
      HStack(spacing: 16) {
        mark(context.state.state)
          .frame(width: 30, height: 30)
        Text(words(context.state.state))
          .font(.headline)
        Spacer()
        buttons(context.state.state, size: 44)
      }
      .padding()
      .activityBackgroundTint(.black.opacity(0.8))
      .activitySystemActionForegroundColor(.cyan)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          mark(context.state.state).frame(width: 28, height: 28)
        }
        DynamicIslandExpandedRegion(.center) {
          Text(words(context.state.state))
        }
        DynamicIslandExpandedRegion(.trailing) {
          buttons(context.state.state, size: 36)
            // Two buttons may not fit beside the camera.
            .dynamicIsland(verticalPlacement: .belowIfTooWide)
        }
      } compactLeading: {
        mark(context.state.state).frame(width: 20, height: 20)
      } compactTrailing: {
        Text(context.state.state == "listening" ? "Listening" : "")
      } minimal: {
        mark(context.state.state).frame(width: 20, height: 20)
      }
    }
  }

  /// Send, then drop it, at the far right, while it listens; otherwise the microphone, to talk.
  private func buttons(_ state: String, size: CGFloat) -> some View {
    HStack(spacing: 10) {
      if state == "listening" {
        round("arrow.up", "Send", size: size, intent: TalkIntent())
        round("xmark", "Drop it", size: size, intent: CancelIntent())
      } else {
        round("mic.fill", "Talk to yapd", size: size, intent: TalkIntent())
      }
    }
  }

  /// One of its buttons, all alike: a cyan symbol on a round cyan glow.
  private func round(_ symbol: String, _ label: String, size: CGFloat, intent: some AppIntent) -> some View {
    Button(intent: intent) {
      Image(systemName: symbol)
        .font(.system(size: size * 0.4, weight: .semibold))
        .foregroundStyle(.cyan)
        .frame(width: size, height: size)
        .background(.cyan.opacity(0.25), in: .circle)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }

  /// The arc reactor, faded while it reaches yapd, glowing while it listens.
  private func mark(_ state: String) -> some View {
    Reactor()
      .opacity(state == "connecting" ? 0.35 : 1)
      .shadow(color: .cyan.opacity(state == "listening" ? 0.9 : 0.4), radius: state == "listening" ? 6 : 3)
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
