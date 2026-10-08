import Foundation

// The menu bar app's checks. The app has no test target, so `bun test` builds
// these with swiftc, together with the files of the app they check, which need
// neither AppKit nor SwiftUI, and runs them by name, or all of them when none
// is named: each check that fails is printed, and any failure ends it with
// status 1.

/// What failed, printed once every check has run.
var failed: [String] = []

/// Notes `what` as failed unless it holds.
@MainActor func check(_ holds: Bool, _ what: String) {
  if !holds { failed.append(what) }
}

let named = Set(CommandLine.arguments.dropFirst())
for unknown in named.subtracting(["cards", "following"]) { check(false, "there are checks called \(unknown)") }
if named.isEmpty || named.contains("cards") { checkCards() }
if named.isEmpty || named.contains("following") { await checkFollowing() }

if failed.isEmpty {
  print("The app's checks pass.")
} else {
  for what in failed { print("Failed: \(what)") }
  exit(1)
}
