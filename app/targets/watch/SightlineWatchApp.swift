import SwiftUI
import WatchKit

@main
struct SightlineWatchApp: App {
  @StateObject private var store = WatchStore.shared

  init() {
    WatchStore.shared.activate()
  }

  var body: some Scene {
    WindowGroup {
      RootView()
        .environmentObject(store)
        .preferredColorScheme(.dark)
    }

    // Long-look for camera alerts and doorbell rings (categories registered by the iPhone
    // app: app/src/alerts/background.ts ALERT_CATEGORY, app/src/alerts/doorbell.ts).
    WKNotificationScene(controller: AlertNotificationController.self, category: "camera-alert")
    WKNotificationScene(controller: AlertNotificationController.self, category: "doorbell-ring")
  }
}
