import AppKit
import SwiftUI

// The card yapd shows, floating under the menu bar icon: what's going on, a
// thread, a pull request, usage, what was missed or what was said, as
// `GET /cards/{id}` describes it. It only reads. Anything to be done is asked
// of yapd by voice, with the same rules as everything else, so there's nothing
// here to approve, deny or send. It never takes focus from what the user is
// doing, and fades once yapd has finished talking about the card.

/// Floats a card under the menu bar icon, and fades it once yapd is done talking about it.
@MainActor
final class Panel {
  /// How wide a card is, in points.
  static let width: CGFloat = 360

  private var panel: NSPanel?
  /// When the card fades, as yapd talks about it. Set up on init, since it has the panel do the fading itself.
  private var fading: Fading!
  /// The card it shows, or showed last.
  private(set) var card: Card?
  /// Told when a card goes away, by its close button or by fading, so yapd can take it down too.
  var closed: (Card) -> Void = { _ in }

  init() {
    fading = Fading(
      Fading.Doing(
        wait: { delay in try? await Task.sleep(for: delay) },
        fade: { [weak self] in await self?.fadeAway() }
      )
    )
  }

  /// Shows a card. `talking` is whether yapd is about to talk about it, which it fades after; otherwise it lingers.
  func show(_ card: Card, talking: Bool) {
    self.card = card
    let panel = panel ?? make()
    self.panel = panel
    let hosting = NSHostingView(rootView: CardView(card: card, tallest: nil, close: { [weak self] in self?.close() }))
    var size = hosting.fittingSize
    let screen = place(height: size.height).screen
    // A long card scrolls rather than run off the screen.
    let most = (screen?.visibleFrame.height ?? 800) * 0.7
    if size.height > most {
      hosting.rootView = CardView(card: card, tallest: most - 120, close: { [weak self] in self?.close() })
      size = hosting.fittingSize
    }
    // Sized once here, so the card doesn't resize the panel as it lays itself out.
    hosting.sizingOptions = []
    panel.setFrame(place(height: size.height).frame, display: false)
    let effect = NSVisualEffectView(frame: NSRect(origin: .zero, size: size))
    effect.material = .popover
    effect.blendingMode = .behindWindow
    effect.state = .active
    effect.wantsLayer = true
    effect.layer?.cornerRadius = 12
    effect.layer?.masksToBounds = true
    hosting.frame = effect.bounds
    hosting.autoresizingMask = [.width, .height]
    effect.addSubview(hosting)
    panel.contentView = effect
    panel.alphaValue = 1
    panel.orderFrontRegardless()
    fading.shown(talking: talking)
  }

  /// Whether yapd is speaking now, with a card up or not: a card fades a while after yapd stops talking about it, even one fetched after it started.
  func heard(speaking: Bool) {
    fading.heard(speaking: speaking)
  }

  /// Takes the card away at once, like when yapd took it down.
  func hide() {
    fading.hidden()
    panel?.orderOut(nil)
  }

  private func close() {
    hide()
    if let card { closed(card) }
  }

  /// Fades the card away, then puts it away, unless another went up or it was taken away meanwhile.
  private func fadeAway() async {
    guard let panel else { return }
    await NSAnimationContext.runAnimationGroup { context in
      context.duration = 0.6
      panel.animator().alphaValue = 0
    }
    guard !Task.isCancelled else { return }
    close()
  }

  private func make() -> NSPanel {
    let panel = FloatingPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
    panel.isFloatingPanel = true
    panel.level = .statusBar
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    return panel
  }

  /// Under the menu bar icon, kept on its screen, or at the top right of the main screen when the icon can't be found.
  private func place(height: CGFloat) -> (frame: NSRect, screen: NSScreen?) {
    // The icon lives in a window of its own as tall as the menu bar.
    let icon = NSApp.windows.first { $0.className.contains("StatusBarWindow") && $0.frame.height < 50 }?.frame
    let screen = icon.flatMap { icon in NSScreen.screens.first { $0.frame.intersects(icon) } } ?? NSScreen.main
    let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let centre = icon?.midX ?? visible.maxX - Self.width / 2 - 12
    let x = min(max(centre - Self.width / 2, visible.minX + 8), visible.maxX - Self.width - 8)
    let top = min(icon?.minY ?? visible.maxY, visible.maxY) - 6
    return (NSRect(x: x, y: max(top - height, visible.minY + 8), width: Self.width, height: height), screen)
  }
}

/// A panel that takes clicks, on its links and its close button, without making yapd the active app.
private final class FloatingPanel: NSPanel {
  override var canBecomeKey: Bool { true }
}

private struct CardView: View {
  let card: Card
  /// How tall the card's body can be before it scrolls, when it's too long for the screen.
  let tallest: CGFloat?
  let close: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(card.title).font(.headline).lineLimit(2)
        Spacer(minLength: 0)
        Button(action: close) {
          Image(systemName: "xmark").font(.caption.weight(.semibold))
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .accessibilityLabel("Close")
      }
      if let tallest {
        ScrollView { Blocks(markdown: card.markdown) }.frame(height: tallest)
      } else {
        Blocks(markdown: card.markdown)
      }
      if let caption = card.caption, !caption.isEmpty {
        Divider()
        Text(caption).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(14)
    .frame(width: Panel.width, alignment: .leading)
    // Only https, as the card's own address is: a thread's message could hold a link of any other kind.
    .environment(\.openURL, OpenURLAction { url in opens(url) ? .systemAction : .discarded })
  }
}

/// A card's markdown: headings, list items, code blocks and paragraphs, each with its own marks and links.
private struct Blocks: View {
  let markdown: String

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(Array(Block.parse(markdown).enumerated()), id: \.offset) { _, block in
        switch block {
        case .heading:
          Text(block.shown).font(.subheadline.weight(.semibold))
        case .item:
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("•").foregroundStyle(.secondary)
            Text(block.shown).fixedSize(horizontal: false, vertical: true)
          }
        case .code:
          // As it is, linking nowhere. In no language, so a long word, like base64 in a command, wraps where it must
          // without a hyphen that isn't in it.
          Text(block.shown)
            .font(.system(.callout, design: .monospaced))
            .typesettingLanguage(.explicit(Locale.Language(identifier: "zxx")))
            .textSelection(.enabled)
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
        case .paragraph:
          Text(block.shown).fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }
}
