import SwiftUI

// yapd on the phone: one button to talk to yapd, as the Mac's shortcut does,
// which the Action button presses too, through the "Talk to yapd" control.
// The phone only plays what yapd says and sends what it hears: yapd runs on
// your server, reached over Tailscale with the token `yapd pair` gives out.

@main
struct YapdApp: App {
  @Environment(\.scenePhase) private var phase
  private let talk = Talk.shared

  var body: some Scene {
    WindowGroup {
      Home(talk: talk)
        // Dark, like the arc reactor in the menu bar.
        .preferredColorScheme(.dark)
        .tint(.cyan)
        .onOpenURL { talk.open($0) }
        .onChange(of: phase, initial: true) { _, phase in talk.appeared(phase == .active) }
    }
  }
}

struct Home: View {
  let talk: Talk
  @State private var settings = false

  var body: some View {
    NavigationStack {
      VStack(spacing: 32) {
        Spacer()
        if talk.paired {
          button
          Text(status).font(.headline).foregroundStyle(.secondary)
          if talk.dictating {
            Button("Drop it", role: .cancel) { talk.cancel() }
          }
        } else {
          Text("Pair with yapd").font(.title2.bold())
          Text("On your server, run yapd pair, then scan its code with the camera or open its link here. Or type in what it printed.")
            .multilineTextAlignment(.center)
            .foregroundStyle(.secondary)
          Button("Type it in") { settings = true }.buttonStyle(.borderedProminent)
        }
        if let trouble = talk.trouble {
          Text(trouble).foregroundStyle(.red).multilineTextAlignment(.center)
        }
        Spacer()
        if talk.paired {
          Text("Set the Action button to Controls, then Talk to yapd, to talk without opening this.")
            .font(.footnote)
            .foregroundStyle(.tertiary)
            .multilineTextAlignment(.center)
        }
      }
      .padding(32)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Color.black.ignoresSafeArea())
      .toolbar {
        Button { settings = true } label: { Image(systemName: "gearshape") }
      }
      .sheet(isPresented: $settings) { Pairing(talk: talk) }
    }
  }

  private var button: some View {
    Button {
      Task { await talk.press() }
    } label: {
      ZStack {
        Circle()
          .fill(talk.dictating ? Color.cyan : Color.cyan.opacity(0.12))
          .overlay(Circle().stroke(Color.cyan, lineWidth: 3))
          .shadow(color: .cyan.opacity(talk.connected ? 0.6 : 0), radius: talk.dictating ? 40 : 20)
        Image(systemName: talk.dictating ? "paperplane.fill" : talk.playing ? "speaker.wave.2.fill" : "mic.fill")
          .font(.system(size: 64))
          .foregroundStyle(talk.dictating ? Color.black : Color.cyan)
      }
      .frame(width: 200, height: 200)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(talk.dictating ? "Send" : "Talk to yapd")
  }

  private var status: String {
    if !talk.connected { return "Not connected" }
    if talk.dictating { return "Listening. Press again to send." }
    if talk.playing { return "Speaking" }
    return "Ready"
  }
}

struct Pairing: View {
  let talk: Talk
  @Environment(\.dismiss) private var dismiss
  @State private var server = Talk.shared.server?.absoluteString ?? ""
  @State private var token = ""
  @State private var invalid = false

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("http://server.tailnet.ts.net:4747", text: $server)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.URL)
          SecureField("Token", text: $token)
        } footer: {
          Text("What yapd pair printed on your server.")
        }
        if invalid {
          Text("That isn't an address and a token.").foregroundStyle(.red)
        }
        if talk.paired {
          Section {
            Button("Unpair", role: .destructive) {
              talk.unpair()
              dismiss()
            }
          }
        }
      }
      .navigationTitle("yapd")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Pair") {
            if talk.pair(server: server, token: token) { dismiss() } else { invalid = true }
          }
        }
      }
    }
  }
}
