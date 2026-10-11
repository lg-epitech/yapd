import AppKit
import ImageIO

// Each recent thread's project icon, as T3 Code draws it: its own image,
// fetched from yapd and kept by its revision, an emoji he chose, or a
// monogram, in a 16 point square with rounded corners, since a menu item shows
// its image at its own size. An image that won't load or decode is drawn as
// the monogram its icon carries, as T3 Code does.

@MainActor @Observable
final class Icons {
  /// What came of fetching a project's image, by its address and revision.
  private enum Fetched {
    case fetching
    case image(CGImage)
    /// Fetched, but not as an image the app can read, which a new revision may be.
    case unreadable
    /// yapd didn't answer with it, which is tried again a while after.
    case failed(Date)
  }

  /// How long a fetch that failed waits before it's tried again.
  private static let again: TimeInterval = 60
  /// No more than yapd sends.
  private static let most = 256 * 1024
  /// The side of the square every icon is drawn in, in points.
  static let side: CGFloat = 16

  private var images: [String: Fetched] = [:]
  /// Each icon drawn, kept so the menu doesn't draw it anew each time it's shown.
  @ObservationIgnored private var drawn: [String: NSImage] = [:]
  @ObservationIgnored private let api: URL

  init(api: URL) {
    self.api = api
  }

  /// The row's project icon, drawn: its image once it's fetched, and the monogram meanwhile, or when it can't be had. A row
  /// with no project gets an empty square, so the titles still line up.
  func icon(for row: Status.Recent) -> NSImage {
    switch row.project?.icon {
    case .image(let url, let revision, _):
      if let image = image(url, revision) { return drawn("image \(url) \(revision)") { Icons.draw(image) } }
    case .emoji(let emoji, _):
      return drawn("emoji \(emoji)") { Icons.draw(emoji: emoji) }
    case .monogram, nil:
      break
    }
    guard let monogram = row.monogram else { return drawn("none") { Icons.draw { _ in } } }
    return drawn("monogram \(monogram.text) \(monogram.color)") { Icons.draw(monogram) }
  }

  /// Forgets the images of rows no longer listed, and of revisions gone since.
  func keep(only rows: [Status.Recent]) {
    let listed = Set(rows.compactMap { row -> String? in
      guard case .image(let url, let revision, _) = row.project?.icon else { return nil }
      return Icons.key(url, revision)
    })
    for key in images.keys where !listed.contains(key) { images[key] = nil }
    drawn = drawn.filter { key, _ in !key.hasPrefix("image ") || listed.contains(String(key.dropFirst(6))) }
  }

  /// The image at `url` on yapd, by its revision, once it's fetched and read; asking for it once it's due.
  private func image(_ url: String, _ revision: String) -> CGImage? {
    let key = Icons.key(url, revision)
    switch images[key] {
    case .image(let image): return image
    case .fetching, .unreadable: return nil
    case .failed(let at) where Date().timeIntervalSince(at) < Icons.again: return nil
    case .failed, nil: break
    }
    guard let address = imageAddress(url, at: api) else {
      // Not a path on yapd's own API, so never fetched.
      images[key] = .unreadable
      return nil
    }
    // Asked for while the menu is drawn, so noted after.
    Task { await self.fetch(address, key) }
    return nil
  }

  private func fetch(_ address: URL, _ key: String) async {
    if case .fetching = images[key] { return }
    if case .image = images[key] { return }
    images[key] = .fetching
    var request = URLRequest(url: address)
    request.timeoutInterval = 10
    guard let (body, response) = try? await URLSession.shared.data(for: request),
      let http = response as? HTTPURLResponse, http.statusCode == 200,
      http.mimeType?.lowercased().hasPrefix("image/") == true, body.count <= Icons.most
    else {
      images[key] = .failed(Date())
      return
    }
    images[key] = Icons.decoded(body).map(Fetched.image) ?? .unreadable
  }

  private static func key(_ url: String, _ revision: String) -> String {
    "\(url) \(revision)"
  }

  /// An image's bytes as a small bitmap, never decoded at a size bigger than the menu needs, or none when neither ImageIO nor
  /// AppKit can read it, as some SVG or ICO files.
  private static func decoded(_ bytes: Data) -> CGImage? {
    let pixels = Int(side * 4)
    if let source = CGImageSourceCreateWithData(bytes as CFData, nil), CGImageSourceGetCount(source) > 0 {
      let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceShouldCacheImmediately: true,
        kCGImageSourceThumbnailMaxPixelSize: pixels,
      ]
      // The largest of an ICO's sizes, so a small one isn't blown up.
      let widths = (0..<CGImageSourceGetCount(source)).map { index in
        (CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any])?[kCGImagePropertyPixelWidth] as? Int ?? 0
      }
      let index = widths.indices.max { widths[$0] < widths[$1] } ?? CGImageSourceGetPrimaryImageIndex(source)
      if let image = CGImageSourceCreateThumbnailAtIndex(source, index, options as CFDictionary) {
        return image
      }
    }
    // An SVG, which only AppKit reads, drawn at the size the menu needs.
    guard let image = NSImage(data: bytes), image.isValid, image.size.width > 0, image.size.height > 0 else { return nil }
    var rect = NSRect(x: 0, y: 0, width: pixels, height: pixels)
    return image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
  }

  private func drawn(_ key: String, _ draw: () -> NSImage) -> NSImage {
    if let image = drawn[key] { return image }
    let image = draw()
    drawn[key] = image
    return image
  }

  /// A 16 point square, drawn with its top left as the origin, as T3 Code's are.
  private static func draw(_ drawing: @escaping (NSRect) -> Void) -> NSImage {
    NSImage(size: NSSize(width: side, height: side), flipped: true) { rect in
      drawing(rect)
      return true
    }
  }

  /// The corners T3 Code rounds an icon by, a quarter of its side.
  private static func rounded(_ rect: NSRect) -> NSBezierPath {
    NSBezierPath(roundedRect: rect, xRadius: rect.width / 4, yRadius: rect.height / 4)
  }

  /// The image, fitted in the square without cropping, its corners rounded.
  private static func draw(_ image: CGImage) -> NSImage {
    let bitmap = NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
    return draw { rect in
      let scale = min(rect.width / CGFloat(image.width), rect.height / CGFloat(image.height))
      let size = NSSize(width: CGFloat(image.width) * scale, height: CGFloat(image.height) * scale)
      let fitted = NSRect(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2, width: size.width, height: size.height)
      NSGraphicsContext.saveGraphicsState()
      rounded(fitted).addClip()
      bitmap.draw(in: fitted, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high.rawValue])
      NSGraphicsContext.restoreGraphicsState()
    }
  }

  /// The emoji, at four fifths of the square T3 Code draws it in.
  private static func draw(emoji: String) -> NSImage {
    draw { rect in
      let text = NSAttributedString(string: emoji, attributes: [.font: NSFont.systemFont(ofSize: 11.2)])
      let size = text.size()
      text.draw(at: NSPoint(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2))
    }
  }

  /// The monogram as T3 Code draws it: bold monospaced letters 8.25 points high, its baseline at 10.8, squeezed to 6 points
  /// wide for one letter or 12 for two, in its colour, on that colour at 14%. A colour T3 Code doesn't have is the menu's text colour.
  private static func draw(_ monogram: Status.Monogram) -> NSImage {
    let color = Tint.named(monogram.color).map(Icons.color) ?? .labelColor
    let letters = monogram.text
    return draw { rect in
      color.withAlphaComponent(0.14).setFill()
      rounded(rect).fill()
      let font = NSFont.monospacedSystemFont(ofSize: 8.25, weight: .bold)
      let text = NSAttributedString(string: letters, attributes: [.font: font, .foregroundColor: color])
      let natural = text.size().width
      guard natural > 0 else { return }
      let width: CGFloat = letters.count == 1 ? 6 : 12
      NSGraphicsContext.saveGraphicsState()
      let squeeze = NSAffineTransform()
      squeeze.translateX(by: rect.midX, yBy: 0)
      squeeze.scaleX(by: width / natural, yBy: 1)
      squeeze.concat()
      text.draw(at: NSPoint(x: -natural / 2, y: 10.8 - font.ascender))
      NSGraphicsContext.restoreGraphicsState()
    }
  }

  /// A colour of T3 Code's, in its light or dark shade as the menu is drawn.
  private static func color(_ tint: Tint) -> NSColor {
    let rgb = { (hex: UInt32) in
      NSColor(srgbRed: CGFloat(hex >> 16 & 0xFF) / 255, green: CGFloat(hex >> 8 & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
    let light = rgb(tint.light)
    let dark = rgb(tint.dark)
    return NSColor(name: "yapd.\(tint.name)") { appearance in
      appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
    }
  }
}
