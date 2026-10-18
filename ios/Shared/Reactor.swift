import SwiftUI

// yapd's mark, the arc reactor, as the menu bar draws it (app/yapd/Mark.swift),
// on an 18-point grid: its casing, eight coils and a core when it's powered,
// only the casing and an empty core when yapd is off. A moon at its foot says
// focus or quiet is on, and a dot at its top that a thread waits on him.

struct Reactor: View {
  var powered = true
  var moon = false
  var dot = false
  /// How far its coils have turned, in degrees, for while it speaks.
  var turned: Double = 0
  var color: Color = .cyan

  var body: some View {
    Canvas { context, size in
      let scale = min(size.width, size.height) / 18
      context.translateBy(x: (size.width - 18 * scale) / 2, y: (size.height - 18 * scale) / 2)
      context.scaleBy(x: scale, y: scale)
      let dotAt = CGPoint(x: 14.6, y: 3.4)
      let moonAt = CGPoint(x: 14.2, y: 13.8)
      let bounds = CGRect(x: 0, y: 0, width: 18, height: 18)
      let shading = GraphicsContext.Shading.color(color)

      // The reactor leaves a gap around each, so it reads apart from the coils beside it.
      var reactor = context
      let gaps = [dot ? circle(dotAt, 3.6) : nil, moon ? circle(moonAt, 4.4) : nil].compactMap { $0 }
      if !gaps.isEmpty { reactor.clip(to: outside(gaps, of: bounds), style: FillStyle(eoFill: true)) }
      draw(in: reactor, shading)

      if dot { context.fill(circle(dotAt, 2.4), with: shading) }
      if moon {
        // The crescent: the disc, less another set up and to its right.
        var crescent = context
        crescent.clip(to: outside([circle(CGPoint(x: moonAt.x + 1.7, y: moonAt.y - 1.3), 2.7)], of: bounds), style: FillStyle(eoFill: true))
        crescent.fill(circle(moonAt, 3.3), with: shading)
      }
    }
    .aspectRatio(1, contentMode: .fit)
  }

  private func draw(in context: GraphicsContext, _ shading: GraphicsContext.Shading) {
    let centre = CGPoint(x: 9, y: 9)
    let line: CGFloat = 1.3
    context.stroke(circle(centre, 7.9), with: shading, lineWidth: line)
    guard powered else {
      context.stroke(circle(centre, 2.3), with: shading, lineWidth: line)
      return
    }
    // Eight coils around the core, set off the vertical so none points straight up.
    for coil in 0..<8 {
      let angle = Double(coil) * 45 - 67.5 + turned
      var block = Path()
      block.addArc(center: centre, radius: 6.3, startAngle: .degrees(angle - 15), endAngle: .degrees(angle + 15), clockwise: false)
      block.addArc(center: centre, radius: 3.9, startAngle: .degrees(angle + 15), endAngle: .degrees(angle - 15), clockwise: true)
      block.closeSubpath()
      context.fill(block, with: shading)
    }
    context.fill(circle(centre, 2.5), with: shading)
  }

  /// All of `bounds` but `holes`, to draw only outside them with the even-odd rule.
  private func outside(_ holes: [Path], of bounds: CGRect) -> Path {
    var path = Path(bounds)
    for hole in holes { path.addPath(hole) }
    return path
  }

  private func circle(_ centre: CGPoint, _ radius: CGFloat) -> Path {
    Path(ellipseIn: CGRect(x: centre.x - radius, y: centre.y - radius, width: radius * 2, height: radius * 2))
  }
}
