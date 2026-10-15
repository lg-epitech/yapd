import AppKit

/// yapd's own mark for the menu bar: an arc reactor, for a voice that's a bit like Jarvis. Off, its coils and core go
/// dark and only the casing is left. On, a moon at its foot says focus or quiet is on, and a dot at its top that a thread
/// waits on him.
@MainActor
enum Mark {
  static let on = image()
  static let off = image(powered: false)
  /// When yapd isn't running: the reactor, faded.
  static let down = image(alpha: 0.35)
  /// On, with a moon, a dot, both or neither.
  private static let marked: [[NSImage]] = [false, true].map { moon in [false, true].map { dot in image(moon: moon, dot: dot) } }

  /// On, with a moon in focus or quiet, and a dot while a thread waits on him.
  static func on(moon: Bool, dot: Bool) -> NSImage {
    marked[moon ? 1 : 0][dot ? 1 : 0]
  }

  private static func image(powered: Bool = true, alpha: CGFloat = 1, moon: Bool = false, dot: Bool = false) -> NSImage {
    let dotAt = NSPoint(x: 14.6, y: 3.4)
    let moonAt = NSPoint(x: 14.2, y: 13.8)
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { bounds in
      NSColor.black.withAlphaComponent(alpha).set()
      // The reactor leaves a gap around each, so it reads apart from the coils beside it.
      let gaps = [dot ? circle(dotAt, radius: 3.6) : nil, moon ? circle(moonAt, radius: 4.4) : nil].compactMap { $0 }
      NSGraphicsContext.saveGraphicsState()
      if !gaps.isEmpty { outside(gaps, of: bounds).addClip() }
      reactor(powered: powered)
      NSGraphicsContext.restoreGraphicsState()
      if dot { circle(dotAt, radius: 2.4).fill() }
      if moon {
        // The crescent: the disc, less another set up and to its right.
        NSGraphicsContext.saveGraphicsState()
        outside([circle(NSPoint(x: moonAt.x + 1.7, y: moonAt.y - 1.3), radius: 2.7)], of: bounds).addClip()
        circle(moonAt, radius: 3.3).fill()
        NSGraphicsContext.restoreGraphicsState()
      }
      return true
    }
    // Drawn in black, and tinted to match the menu bar.
    image.isTemplate = true
    return image
  }

  /// The reactor itself, in the colour that's set: its casing, and its coils and core when it's powered, else an empty core.
  private static func reactor(powered: Bool) {
    let centre = NSPoint(x: 9, y: 9)
    let line: CGFloat = 1.3

    let casing = circle(centre, radius: 7.9)
    casing.lineWidth = line
    casing.stroke()

    guard powered else {
      let core = circle(centre, radius: 2.3)
      core.lineWidth = line
      core.stroke()
      return
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
  }

  /// All of `bounds` but `holes`, to draw only outside them.
  private static func outside(_ holes: [NSBezierPath], of bounds: NSRect) -> NSBezierPath {
    let path = NSBezierPath(rect: bounds)
    for hole in holes { path.append(hole) }
    path.windingRule = .evenOdd
    return path
  }

  private static func circle(_ centre: NSPoint, radius: CGFloat) -> NSBezierPath {
    NSBezierPath(ovalIn: NSRect(x: centre.x - radius, y: centre.y - radius, width: radius * 2, height: radius * 2))
  }
}
