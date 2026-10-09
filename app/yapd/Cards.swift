import Foundation

// What the panel shows of a card, and which of its links it opens, apart from
// AppKit and SwiftUI, so that app/checks can build it with swiftc on its own
// and check it, since the app has no test target. The panel only lays it out.

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

/// Whether the panel opens a link on a card in the browser: only an https page, as the card's own address is, since a thread's
/// message could hold a link of any other kind, like a file, a script or another app's scheme.
func opens(_ url: URL) -> Bool {
  url.scheme?.lowercased() == "https" && !(url.host(percentEncoded: false) ?? "").isEmpty
}

/// A block of a card's markdown.
enum Block: Equatable {
  case heading(String)
  case item(String)
  case code(String)
  case paragraph(String)

  /// What the panel shows of it: a line with its own marks, like bold, code and links, through AttributedString's markdown,
  /// and a code block as it is, as text that links nowhere, since what a thread waits on is only ever text.
  var shown: AttributedString {
    switch self {
    case .code(let text):
      AttributedString(text)
    case .heading(let text), .item(let text), .paragraph(let text):
      (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }
  }

  /// Splits markdown into blocks, with code blocks where yapd sees them: one opens only at the very start of a line,
  /// and ends only at a fence at least as long as the one it began with, indented three spaces at most.
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
        // One indented further is a line of the code, so what follows it, which yapd left as it is, isn't read as markdown.
        if let closing = line.firstMatch(of: /^ {0,3}(`+|~+)[ \t]*$/)?.output.1,
           closing.first == open.mark, closing.count >= open.length {
          blocks.append(.code(code.joined(separator: "\n")))
          fence = nil
          code = []
        } else {
          code.append(line)
        }
        continue
      }
      // Not an indented one, which yapd escapes, nor one with a backtick after its backticks, which is a code span.
      if let opening = line.firstMatch(of: /^(`{3,})[^`]*$|^(~{3,})/),
         let mark = opening.output.1 ?? opening.output.2, let first = mark.first {
        flush()
        fence = (first, mark.count)
        continue
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
