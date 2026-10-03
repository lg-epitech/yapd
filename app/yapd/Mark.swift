import AppKit

/// yapd's own mark for the menu bar: a speech bubble with a letter in it, struck through while yapd is off.
@MainActor
enum Mark {
  static let on = image("y")
  static let off = image("y", struck: true)
  /// When yapd isn't running.
  static let down = image("!")

  private static func image(_ letter: String, struck: Bool = false) -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
      let line: CGFloat = 1.4
      let (left, right, top, bottom, radius): (CGFloat, CGFloat, CGFloat, CGFloat, CGFloat) = (1.7, 16.3, 1.7, 12.6, 3.8)
      let bubble = NSBezierPath()
      bubble.move(to: NSPoint(x: (left + right) / 2, y: top))
      bubble.appendArc(from: NSPoint(x: right, y: top), to: NSPoint(x: right, y: bottom), radius: radius)
      bubble.appendArc(from: NSPoint(x: right, y: bottom), to: NSPoint(x: left, y: bottom), radius: radius)
      // The tail, down and to the left.
      bubble.line(to: NSPoint(x: 8.6, y: bottom))
      bubble.line(to: NSPoint(x: 3.6, y: 16.6))
      bubble.line(to: NSPoint(x: 5.2, y: bottom))
      bubble.appendArc(from: NSPoint(x: left, y: bottom), to: NSPoint(x: left, y: top), radius: radius)
      bubble.appendArc(from: NSPoint(x: left, y: top), to: NSPoint(x: right, y: top), radius: radius)
      bubble.close()
      bubble.lineWidth = line
      bubble.lineJoinStyle = .round
      NSColor.black.setStroke()
      bubble.stroke()

      let font = NSFont.systemFont(ofSize: 10.5, weight: .heavy)
      let rounded = font.fontDescriptor.withDesign(.rounded).flatMap { NSFont(descriptor: $0, size: 10.5) } ?? font
      let text = NSAttributedString(string: letter, attributes: [.font: rounded, .foregroundColor: NSColor.black])
      // Centred on its ink, in the body of the bubble.
      let ink = text.boundingRect(with: .zero, options: [.usesDeviceMetrics])
      let baseline = (top + bottom) / 2 + ink.midY
      text.draw(at: NSPoint(x: (left + right) / 2 - ink.midX, y: baseline - rounded.ascender))

      if struck {
        let slash = NSBezierPath()
        slash.move(to: NSPoint(x: 2, y: 16.5))
        slash.line(to: NSPoint(x: 16.5, y: 2))
        slash.lineCapStyle = .round
        // A gap either side, so it reads as struck through rather than drawn over.
        NSGraphicsContext.current?.compositingOperation = .clear
        slash.lineWidth = 4
        slash.stroke()
        NSGraphicsContext.current?.compositingOperation = .sourceOver
        slash.lineWidth = line
        slash.stroke()
      }
      return true
    }
    // Drawn in black, and tinted to match the menu bar.
    image.isTemplate = true
    return image
  }
}
