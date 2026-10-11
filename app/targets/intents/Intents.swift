import AppIntents
import Foundation

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
    .result(opensIntent: OpenURLIntent(Shared.cameraURL(camera.id)))
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
      phrases: ["Open a camera in \(.applicationName)", "Show a camera in \(.applicationName)"],
      shortTitle: "Open Camera",
      systemImageName: "video.fill"
    )
    AppShortcut(
      intent: ShowAlertsIntent(),
      phrases: ["Show camera alerts in \(.applicationName)"],
      shortTitle: "Show Alerts",
      systemImageName: "bell"
    )
  }
}
