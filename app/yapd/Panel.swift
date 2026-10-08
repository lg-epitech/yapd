import AppKit
import SwiftUI

// The card yapd shows, floating under the menu bar icon: what's going on, a
// thread, a pull request, usage, what was missed or what was said, as
// `GET /cards/{id}` describes it. It only reads. Anything to be done is asked
// of yapd by voice, with the same rules as everything else, so there's nothing
// here to approve, deny or send. It never takes focus from what the user is
// doing, and fades once yapd has finished talking about the card.

/// What `GET /cards/{id}` returns.
struct Card: Decodable, Equatable {
  let id: String
  let kind: String
  let title: String
  let markdown: String
  /// Only ever an https address from T3 Code.
  let url: String?
  /// What yapd said with it.
  let caption: String?
}

/// Floats a card under the menu bar icon, and fades it once yapd is done talking about it.
@MainActor
final class Panel {
  /// How wide a card is, in points.
  static let width: CGFloat = 360
  /// How long a card stays up once yapd stops talking about it, or after it's shown with nothing said.
  private static let linger: Duration = .seconds(20)
  /// How long a card that yapd is about to talk about waits for it to start, before it lingers as if it had.
  private static let patience: Duration = .seconds(5)

  /// Where a card is in being talked about: not yet, now, or done with.
  private enum Talk { case coming, talking, done }

  private var panel: NSPanel?
  private var talk = Talk.done
  private var fading: Task<Void, Never>?
  /// The card it shows, or showed last.
  private(set) var card: Card?
  /// Told when a card goes away, by its close button or by fading, so yapd can take it down too.
  var closed: (Card) -> Void = { _ in }

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
    talk = talking ? .coming : .done
    fade(after: talking ? Self.patience : Self.linger)
  }

  /// Whether yapd is speaking now: a card fades a while after yapd stops talking about it.
  func heard(speaking: Bool) {
    guard panel?.isVisible == true else { return }
    switch talk {
    case .coming where speaking:
      talk = .talking
      fading?.cancel()
    case .talking where !speaking:
      talk = .done
      fade(after: Self.linger)
    default:
      break
    }
  }

  /// Takes the card away at once, like when yapd took it down.
  func hide() {
    fading?.cancel()
    panel?.orderOut(nil)
  }

  private func close() {
    hide()
    if let card { closed(card) }
  }

  private func fade(after delay: Duration) {
    fading?.cancel()
    fading = Task { [weak self] in
      try? await Task.sleep(for: delay)
      guard !Task.isCancelled, let self, let panel = self.panel else { return }
      // Not yet talked about after all: it lingers as if it had been.
      if self.talk == .coming {
        self.talk = .done
        return self.fade(after: Self.linger)
      }
      await NSAnimationContext.runAnimationGroup { context in
        context.duration = 0.6
        panel.animator().alphaValue = 0
      }
      guard !Task.isCancelled else { return }
      self.close()
    }
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
    .environment(\.openURL, OpenURLAction { url in url.scheme?.lowercased() == "https" ? .systemAction : .discarded })
  }
}

/// A card's markdown: headings, list items, code blocks and paragraphs, each with its own marks and links.
private struct Blocks: View {
  let markdown: String

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(Array(Block.parse(markdown).enumerated()), id: \.offset) { _, block in
        switch block {
        case .heading(let text):
          Text(inline(text)).font(.subheadline.weight(.semibold))
        case .item(let text):
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("•").foregroundStyle(.secondary)
            Text(inline(text)).fixedSize(horizontal: false, vertical: true)
          }
        case .code(let text):
          // As it is: what a thread waits on is only ever text, never a link.
          Text(verbatim: text)
            .font(.system(.callout, design: .monospaced))
            .textSelection(.enabled)
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
        case .paragraph(let text):
          Text(inline(text)).fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  /// A line's own marks, like bold, code and links, through AttributedString's markdown.
  private func inline(_ text: String) -> AttributedString {
    (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
  }
}

/// A block of a card's markdown.
private enum Block {
  case heading(String)
  case item(String)
  case code(String)
  case paragraph(String)

  /// Splits markdown into blocks. A code block ends only at a fence at least as long as the one it began with.
  static func parse(_ markdown: String) -> [Block] {
    var blocks: [Block] = []
    var paragraph: [String] = []
    var fence: (mark: Character, length: Int)?
    var code: [String] = []
    func flush() {
      if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))) }
      paragraph = []
    }
    for line in markdown.components(separatedBy: "\n") {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if let open = fence {
        if trimmed.count >= open.length, trimmed.allSatisfy({ $0 == open.mark }) {
          blocks.append(.code(code.joined(separator: "\n")))
          fence = nil
          code = []
        } else {
          code.append(line)
        }
        continue
      }
      if let mark = trimmed.first, mark == "`" || mark == "~" {
        let run = trimmed.prefix { $0 == mark }.count
        if run >= 3 {
          flush()
          fence = (mark, run)
          continue
        }
      }
      if trimmed.isEmpty {
        flush()
      } else if let heading = trimmed.firstMatch(of: /^#{1,6}\s+(.*)$/) {
        flush()
        blocks.append(.heading(String(heading.output.1)))
      } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
        flush()
        blocks.append(.item(String(trimmed.dropFirst(2))))
      } else {
        paragraph.append(line)
      }
    }
    flush()
    // One left open, like a message cut short, still shows what it has.
    if fence != nil { blocks.append(.code(code.joined(separator: "\n"))) }
    return blocks
  }
}
