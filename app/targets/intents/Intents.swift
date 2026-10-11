import AppIntents
import Foundation
import SwiftUI

// OpenURLIntent needs iOS 18. The extension itself is built for iOS 17 by the build plugin,
// so everything here is gated; on iOS 17 the shortcuts just don't appear.

/// "Open a camera in Sightline": Siri asks which camera, then the app opens on it.
@available(iOS 18.0, *)
struct OpenCameraIntent: AppIntent {
  static let title: LocalizedStringResource = "Open Camera"
  static let description = IntentDescription("Opens live view for one of your cameras.")

  @Parameter(title: "Camera")
  var camera: CameraEntity

  func perform() async throws -> some IntentResult & OpensIntent {
    SightlineShortcuts.refreshCameraNames()
    return .result(opensIntent: OpenURLIntent(Shared.cameraURL(camera.id)))
  }
}

/// "Show my cameras in Sightline": opens the Live tab.
@available(iOS 18.0, *)
struct ShowCamerasIntent: AppIntent {
  static let title: LocalizedStringResource = "Show Cameras"
  static let description = IntentDescription("Opens all your cameras.")

  func perform() async throws -> some IntentResult & OpensIntent {
    .result(opensIntent: OpenURLIntent(URL(string: "sightline://")!))
  }
}

/// "Show camera alerts in Sightline": opens Review.
@available(iOS 18.0, *)
struct ShowAlertsIntent: AppIntent {
  static let title: LocalizedStringResource = "Show Alerts"
  static let description = IntentDescription("Opens recent camera alerts.")

  func perform() async throws -> some IntentResult & OpensIntent {
    .result(opensIntent: OpenURLIntent(URL(string: "sightline://review")!))
  }
}

// Questions Siri answers out loud (also on HomePod, where only the spoken answer is used) from
// the summary the app keeps in the App Group; on screens the snippet adds the latest picture.
// See Assistant.swift. None of these open the app.

/// "Who's at the door in Sightline?"
@available(iOS 18.0, *)
struct WhoIsAtTheDoorIntent: AppIntent {
  static let title: LocalizedStringResource = "Who's at the Door"
  static let description = IntentDescription("Tells you who was last seen at your door, with a picture.")

  func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
    let reply = Assistant.whoIsAtTheDoor()
    return .result(dialog: "\(reply.text)", view: AssistantSnippet(reply: reply))
  }
}

/// "Any packages today in Sightline?"
@available(iOS 18.0, *)
struct PackagesTodayIntent: AppIntent {
  static let title: LocalizedStringResource = "Any Packages Today"
  static let description = IntentDescription("Tells you whether a package came today and whether it looks like it's still outside.")

  func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
    let reply = Assistant.packagesToday()
    return .result(dialog: "\(reply.text)", view: AssistantSnippet(reply: reply))
  }
}

/// "What happened on Backyard in Sightline?"
@available(iOS 18.0, *)
struct WhatHappenedIntent: AppIntent {
  static let title: LocalizedStringResource = "What Happened on a Camera"
  static let description = IntentDescription("Tells you what one of your cameras saw today.")

  @Parameter(title: "Camera")
  var camera: CameraEntity

  func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
    SightlineShortcuts.refreshCameraNames()
    let reply = Assistant.whatHappened(cameraKey: camera.id, cameraName: camera.name)
    return .result(dialog: "\(reply.text)", view: AssistantSnippet(reply: reply))
  }
}

/// "What happened today in Sightline?"
@available(iOS 18.0, *)
struct WhatHappenedTodayIntent: AppIntent {
  static let title: LocalizedStringResource = "What Happened Today"
  static let description = IntentDescription("Tells you what your cameras saw today.")

  func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
    let reply = Assistant.whatHappened(cameraKey: nil, cameraName: nil)
    return .result(dialog: "\(reply.text)", view: AssistantSnippet(reply: reply))
  }
}

/// "Ask Sightline a question": opens the app's Ask screen, which answers on the iPhone.
@available(iOS 18.0, *)
struct AskCamerasIntent: AppIntent {
  static let title: LocalizedStringResource = "Ask Your Cameras"
  static let description = IntentDescription("Opens Sightline and answers a question about what your cameras saw, on your iPhone.")

  @Parameter(title: "Question")
  var question: String

  func perform() async throws -> some IntentResult & OpensIntent {
    var url = URLComponents()
    url.scheme = "sightline"
    url.host = "ask"
    url.queryItems = [URLQueryItem(name: "q", value: question)]
    return .result(opensIntent: OpenURLIntent(url.url ?? URL(string: "sightline://ask")!))
  }
}

@available(iOS 18.0, *)
struct SightlineShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: ShowCamerasIntent(),
      phrases: ["Show my cameras in \(.applicationName)", "Open \(.applicationName)"],
      shortTitle: "Show Cameras",
      systemImageName: "video"
    )
    AppShortcut(
      intent: OpenCameraIntent(),
      phrases: [
        "Open a camera in \(.applicationName)",
        "Show a camera in \(.applicationName)",
        "Show \(\.$camera) in \(.applicationName)",
        "Open \(\.$camera) in \(.applicationName)",
      ],
      shortTitle: "Open Camera",
      systemImageName: "video.fill"
    )
    AppShortcut(
      intent: ShowAlertsIntent(),
      phrases: ["Show camera alerts in \(.applicationName)"],
      shortTitle: "Show Alerts",
      systemImageName: "bell"
    )
    AppShortcut(
      intent: WhoIsAtTheDoorIntent(),
      phrases: [
        "Who's at the door in \(.applicationName)",
        "Who is at the door in \(.applicationName)",
        "Ask \(.applicationName) who's at the door",
        "Check the door with \(.applicationName)",
      ],
      shortTitle: "Who's at the Door",
      systemImageName: "door.left.hand.open"
    )
    AppShortcut(
      intent: PackagesTodayIntent(),
      phrases: [
        "Any packages today in \(.applicationName)",
        "Did a package come in \(.applicationName)",
        "Ask \(.applicationName) about packages",
        "Check for packages with \(.applicationName)",
      ],
      shortTitle: "Any Packages",
      systemImageName: "shippingbox"
    )
    AppShortcut(
      intent: WhatHappenedIntent(),
      phrases: [
        "What happened on \(\.$camera) in \(.applicationName)",
        "What happened in \(\.$camera) with \(.applicationName)",
        "Ask \(.applicationName) what happened on \(\.$camera)",
      ],
      shortTitle: "What Happened on a Camera",
      systemImageName: "video.badge.checkmark"
    )
    AppShortcut(
      intent: WhatHappenedTodayIntent(),
      phrases: [
        "What happened today in \(.applicationName)",
        "Ask \(.applicationName) what happened today",
      ],
      shortTitle: "What Happened Today",
      systemImageName: "clock.arrow.circlepath"
    )
    AppShortcut(
      intent: AskCamerasIntent(),
      phrases: [
        "Ask \(.applicationName) a question",
        "Ask my cameras in \(.applicationName)",
      ],
      shortTitle: "Ask Your Cameras",
      systemImageName: "sparkles"
    )
  }

  /// Phrases with a camera name ("Show Front Door in Sightline") only know the names after
  /// this runs. The app can't call it (this provider lives in the extension), so intents that
  /// use cameras refresh it; the names come from the App Group (CameraQuery in Shared.swift).
  static func refreshCameraNames() {
    updateAppShortcutParameters()
  }
}
