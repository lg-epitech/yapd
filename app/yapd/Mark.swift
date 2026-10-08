import AppKit

/// yapd's own mark for the menu bar: an arc reactor, for a voice that's a bit like Jarvis. Off, its coils and core go
/// dark and only the casing is left.
@MainActor
enum Mark {
  static let on = image()
  static let off = image(powered: false)
  /// When yapd isn't running: the reactor, faded.
  static let down = image(alpha: 0.35)

  private static func image(powered: Bool = true, alpha: CGFloat = 1) -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
      let centre = NSPoint(x: 9, y: 9)
      let line: CGFloat = 1.3
      NSColor.black.withAlphaComponent(alpha).set()

      let casing = circle(centre, radius: 7.9)
      casing.lineWidth = line
      casing.stroke()

      guard powered else {
        let core = circle(centre, radius: 2.3)
        core.lineWidth = line
        core.stroke()
        return true
      }
      // Eight coils around the core, set off the vertical so none points straight up.
      for coil in 0..<8 {
        let angle = CGFloat(coil) * 45 - 67.5
        let block = NSBezierPath()
        block.appendArc(withCenter: centre, radius: 6.3, startAngle: angle - 15, endAngle: angle + 15)
        block.appendArc(withCenter: centre, radius: 3.9, startAngle: angle + 15, endAngle: angle - 15, clockwise: true)
        block.close()
        block.fill()
      }
      circle(centre, radius: 2.5).fill()
      return true
    }
    // Drawn in black, and tinted to match the menu bar.
    image.isTemplate = true
    return image
  }

  private static func circle(_ centre: NSPoint, radius: CGFloat) -> NSBezierPath {
    NSBezierPath(ovalIn: NSRect(x: centre.x - radius, y: centre.y - radius, width: radius * 2, height: radius * 2))
  }
}
