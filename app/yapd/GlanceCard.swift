import AppKit
import SwiftUI

// The card at the top of a recent thread's panel, as Glance has it: what the
// thread is, what it's doing, its branch and pull request, whether it's muted,
// and the latest told of it. It only shows: what can be done with the thread
// is in the menu's own items under it.

/// The card as a menu item's view, sized to it, and resized when it's swapped for one with more, as when yapd's details come.
@MainActor
final class GlanceItem: NSView {
  private let hosting: NSHostingView<GlanceCard>

  init(_ card: GlanceCard) {
    hosting = NSHostingView(rootView: card)
    super.init(frame: .zero)
    // Sized here, so the card doesn't resize the menu as it lays itself out.
    hosting.sizingOptions = []
    addSubview(hosting)
    fit(card)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override var intrinsicContentSize: NSSize {
    frame.size
  }

  /// Shows `card` in place of the one it shows, unless it's the same, and fits the item to it: whether its size changed.
  func show(_ card: GlanceCard) -> Bool {
    guard card.glance != hosting.rootView.glance || card.icon !== hosting.rootView.icon else { return false }
    let before = frame.size
    hosting.rootView = card
    fit(card)
    return frame.size != before
  }

  private func fit(_ card: GlanceCard) {
    // Measured apart, as the hosting view shown no longer sizes itself.
    let size = NSHostingView(rootView: card).fittingSize
    setFrameSize(NSSize(width: GlanceCard.width, height: ceil(size.height)))
    hosting.frame = bounds
    invalidateIntrinsicContentSize()
  }
}

/// The card's layout, in the menu's fonts and text colours, its text lined up with the items under it.
struct GlanceCard: View {
  /// How wide the panel is, in points.
  static let width: CGFloat = 320
  /// Where text starts, as the menu's own items have it.
  static let margin: CGFloat = 15

  let glance: Glance
  /// The project's icon, as the row has it.
  let icon: NSImage

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 8) {
        Image(nsImage: icon).frame(width: Icons.side, height: Icons.side).padding(.top, 1)
        VStack(alignment: .leading, spacing: 2) {
          Text(glance.title).font(.headline).lineLimit(2).fixedSize(horizontal: false, vertical: true)
          Text(glance.place).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
        }
      }
      if !facts.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          ForEach(Array(facts.enumerated()), id: \.offset) { _, fact in
            HStack(alignment: .firstTextBaseline, spacing: 8) {
              Image(systemName: fact.symbol).font(.system(size: fact.size)).foregroundStyle(fact.tint).frame(width: Icons.side)
              Text(fact.text).font(.callout).lineLimit(fact.lines).truncationMode(fact.lines == 1 ? .middle : .tail)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
        }
      }
      if let latest = glance.latest {
        Divider()
        VStack(alignment: .leading, spacing: 4) {
          HStack(alignment: .firstTextBaseline) {
            heading("Latest")
            Spacer(minLength: 8)
            if let heard = glance.heard { Text(heard).font(.caption).foregroundStyle(.secondary) }
          }
          Text(latest.text).font(.callout).lineLimit(12).fixedSize(horizontal: false, vertical: true)
        }
      }
      if !glance.earlier.isEmpty {
        VStack(alignment: .leading, spacing: 5) {
          heading("Earlier")
          ForEach(glance.earlier) { told in
            HStack(alignment: .firstTextBaseline, spacing: 8) {
              // A dot beside what he hasn't heard, as Mail has beside what he hasn't read, under the marks above.
              Image(systemName: "circle.fill").font(.system(size: 6)).foregroundStyle(told.unheard == true ? Color.accentColor : .clear)
                .frame(width: Icons.side)
              Text(told.when).font(.caption).foregroundStyle(.secondary).frame(width: 62, alignment: .leading)
              Text(told.text).font(.callout).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
          }
        }
      }
    }
    .padding(.horizontal, Self.margin)
    .padding(.vertical, 8)
    .frame(width: Self.width, alignment: .leading)
  }

  /// One of what the card says of the thread beside its mark, lined up under the icon: a dot, or a symbol.
  private struct Fact {
    let symbol: String
    let size: CGFloat
    let tint: Color
    let text: String
    /// How many lines it wraps to at most: a branch is cut short in its middle, so both ends of it show.
    var lines = 1
  }

  /// What it's doing, its branch, its pull request, and whether it's muted or how much of it he hasn't heard.
  private var facts: [Fact] {
    [
      glance.doing.map { Fact(symbol: "circle.fill", size: 7, tint: Glance.colour($0.tone), text: $0.line, lines: 2) },
      glance.branch.map { Fact(symbol: "arrow.triangle.branch", size: 11, tint: .secondary, text: $0) },
      glance.pr.map { Fact(symbol: "arrow.triangle.pull", size: 11, tint: .secondary, text: $0, lines: 2) },
      glance.muted.map { Fact(symbol: "bell.slash", size: 11, tint: .secondary, text: $0, lines: 2) },
      glance.unheard.map { Fact(symbol: "circle.fill", size: 7, tint: .accentColor, text: $0, lines: 2) },
    ].compactMap { $0 }
  }

  private func heading(_ text: String) -> some View {
    Text(text).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
  }
}

extension Glance {
  /// The dot's colour for what a thread is doing.
  fileprivate static func colour(_ tone: Tone) -> Color {
    switch tone {
    case .busy: .green
    case .waiting: .orange
    case .failed: .red
    case .limited: .yellow
    case .still: .secondary
    }
  }
}
