import AppKit

// A recent thread's row in the menu, drawn by the app since a menu item with
// a submenu can't have a second line, an icon and its own click all at once:
// its project's icon, its label with how long ago it ended under it, and the
// arrow of the panel it opens on hover, highlighted as a native item is. A
// row he can't hear again has its text dimmed, and clicking it does nothing,
// but it still opens its panel, since muting it works either way.

/// A recent thread's row, as `Menu.Row` has it.
@MainActor
final class RecentRow: NSView {
  /// Told when he clicks it, letting go over it, or VoiceOver presses it.
  var clicked: () -> Void = {}

  /// Where the icon starts, and the gap after it, as a native item's image column has them.
  private static let leading: CGFloat = 15
  private static let gap: CGFloat = 5
  /// From the arrow's right to the row's.
  private static let trailing: CGFloat = 13
  /// Above the label and under the line under it.
  private static let padding: CGFloat = 4
  /// How far in the highlight is drawn from each side, and how round its corners are, as macOS 14 and later draw a menu's.
  private static let inset: CGFloat = 5
  private static var corners: CGFloat {
    if #available(macOS 26, *) { 7 } else { 4 }
  }

  private let selection = NSVisualEffectView()
  private let icon = NSImageView()
  private let label = NSTextField(labelWithString: "")
  private let detail = NSTextField(labelWithString: "")
  private let arrow = NSImageView()
  private var highlighted = false
  private var hearable = true

  init() {
    super.init(frame: .zero)
    autoresizingMask = [.width]
    selection.material = .selection
    selection.blendingMode = .withinWindow
    selection.state = .active
    selection.isEmphasized = true
    selection.wantsLayer = true
    selection.layer?.masksToBounds = true
    selection.isHidden = true
    addSubview(selection)
    icon.imageScaling = .scaleProportionallyUpOrDown
    addSubview(icon)
    for (field, size) in [(label, CGFloat(0)), (detail, NSFont.smallSystemFontSize)] {
      field.font = NSFont.menuFont(ofSize: size)
      field.lineBreakMode = .byTruncatingTail
      field.maximumNumberOfLines = 1
      addSubview(field)
    }
    arrow.image = NSImage(systemSymbolName: "chevron.right", accessibilityDescription: nil)?
      .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 10, weight: .semibold))
    addSubview(arrow)
    // It's one item to VoiceOver, told by what it shows.
    for part in [selection, icon, label, detail, arrow] as [NSView] { part.setAccessibilityElement(false) }
    colour()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  /// Shows `row`, with its project's `image`: sized to fit it the first time, which the menu widens to its own width, and
  /// keeping that width after, as the open menu does, a longer line being cut short.
  func show(_ row: Menu.Row, image: NSImage) {
    icon.image = image
    label.stringValue = row.label
    detail.stringValue = row.detail
    detail.isHidden = row.detail.isEmpty
    hearable = row.hearable
    setAccessibilityLabel(row.told)
    colour()
    let text = max(label.intrinsicContentSize.width, detail.isHidden ? 0 : detail.intrinsicContentSize.width)
    let width = Self.leading + Icons.side + Self.gap + ceil(text) + 16 + (arrow.image?.size.width ?? 0) + Self.trailing
    let height = Self.padding * 2 + label.intrinsicContentSize.height + (detail.isHidden ? 0 : detail.intrinsicContentSize.height)
    setFrameSize(NSSize(width: frame.width == 0 ? ceil(width) : frame.width, height: ceil(height)))
    needsLayout = true
  }

  /// Drawn highlighted, as the menu's own items are, while the pointer or the keyboard is on it, and while its panel is open.
  func highlight(_ on: Bool) {
    guard highlighted != on else { return }
    highlighted = on
    selection.isHidden = !on
    colour()
  }

  /// Its text in the selected text colour while it's highlighted, and dimmed, highlighted or not, when he can't hear it again.
  private func colour() {
    let selected = NSColor.selectedMenuItemTextColor
    switch (highlighted, hearable) {
    case (true, true): (label.textColor, detail.textColor) = (selected, selected)
    case (true, false): (label.textColor, detail.textColor) = (selected.withAlphaComponent(0.6), selected.withAlphaComponent(0.6))
    case (false, true): (label.textColor, detail.textColor) = (.labelColor, .secondaryLabelColor)
    case (false, false): (label.textColor, detail.textColor) = (.tertiaryLabelColor, .tertiaryLabelColor)
    }
    arrow.contentTintColor = highlighted ? selected : .secondaryLabelColor
    icon.alphaValue = hearable || highlighted ? 1 : 0.5
  }

  override func layout() {
    super.layout()
    selection.frame = bounds.insetBy(dx: Self.inset, dy: 0)
    selection.layer?.cornerRadius = Self.corners
    let lines = label.intrinsicContentSize.height + (detail.isHidden ? 0 : detail.intrinsicContentSize.height)
    // Drawn from the bottom up: the line under the label first.
    let bottom = floor((bounds.height - lines) / 2)
    let size = arrow.image?.size ?? .zero
    arrow.frame = NSRect(x: bounds.maxX - Self.trailing - size.width, y: floor((bounds.height - size.height) / 2), width: size.width, height: size.height)
    let x = Self.leading + Icons.side + Self.gap
    let width = max(0, arrow.frame.minX - 8 - x)
    detail.frame = NSRect(x: x, y: bottom, width: width, height: detail.isHidden ? 0 : detail.intrinsicContentSize.height)
    label.frame = NSRect(x: x, y: detail.frame.maxY, width: width, height: label.intrinsicContentSize.height)
    // Beside the label, as a native item's image is beside its title.
    icon.frame = NSRect(x: Self.leading, y: floor(label.frame.midY - Icons.side / 2), width: Icons.side, height: Icons.side)
  }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
    true
  }

  /// The menu its panel opens from takes the mouse-up, so the click is followed from the mouse-down, until he lets go over it,
  /// or drags off it, when it's given back to the menu.
  override func mouseDown(with event: NSEvent) {
    guard event.type == .leftMouseDown, let window else { return super.mouseDown(with: event) }
    var over = false
    window.trackEvents(matching: [.leftMouseDragged, .leftMouseUp], timeout: NSEvent.foreverDuration, mode: .eventTracking) { [weak self] tracked, stop in
      guard let self, let tracked else {
        stop.pointee = true
        return
      }
      let inside = self.bounds.contains(self.convert(tracked.locationInWindow, from: nil))
      if tracked.type == .leftMouseDragged && !inside {
        window.postEvent(tracked, atStart: true)
        stop.pointee = true
      } else if tracked.type == .leftMouseUp {
        over = inside
        stop.pointee = true
      }
    }
    if over { clicked() }
  }

  override func isAccessibilityElement() -> Bool {
    true
  }

  override func accessibilityRole() -> NSAccessibility.Role? {
    .menuItem
  }

  /// As a click: it says the row's latest update again, unless he can't hear it again, when nothing happens.
  override func accessibilityPerformPress() -> Bool {
    guard hearable else { return false }
    clicked()
    return true
  }
}
