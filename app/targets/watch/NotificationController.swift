import SwiftUI
import UIKit
import UserNotifications
import WatchKit

/// What the long-look shows: the alert text and a snapshot. The picture is the notification's
/// own attachment when the watch got it; otherwise a fresh snapshot of the camera, from the
/// phone or the Hub (the same paths as the app).
final class NotificationModel: ObservableObject {
  @Published var title = ""
  @Published var body = ""
  @Published var image: UIImage?
  @Published var doorbell = false
}

final class AlertNotificationController: WKUserNotificationHostingController<AlertNotificationView> {
  private let model = NotificationModel()

  override var body: AlertNotificationView {
    AlertNotificationView(model: model)
  }

  override func didReceive(_ notification: UNNotification) {
    let content = notification.request.content
    model.title = content.title
    model.body = content.body
    model.doorbell = content.categoryIdentifier == "doorbell-ring"

    for attachment in content.attachments {
      if let data = try? Data(contentsOf: attachment.url), let image = UIImage(data: data) {
        model.image = image
        return
      }
    }

    let data = Self.payloadData(content.userInfo)
    guard let system = data["systemId"] as? String, let camera = data["cameraId"] as? String else { return }
    let key = "\(system):\(camera)"
    let model = self.model
    Task {
      let store = WatchStore.shared
      if await store.loadSnapshot(key, size: 400) {
        let image = await MainActor.run { store.snapshots[key]?.image }
        await MainActor.run { model.image = image }
      }
    }
  }

  /// Expo puts custom data under "body" (dictionary or JSON string); older payloads use "data".
  static func payloadData(_ userInfo: [AnyHashable: Any]) -> [String: Any] {
    for key in ["body", "data"] {
      if let dict = userInfo[key] as? [String: Any] { return dict }
      if let s = userInfo[key] as? String, let d = s.data(using: .utf8),
         let dict = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { return dict }
    }
    return [:]
  }
}

struct AlertNotificationView: View {
  @ObservedObject var model: NotificationModel

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if model.doorbell {
        Label("Someone’s at the door", systemImage: "bell.fill")
          .font(.headline)
          .foregroundStyle(accent)
      }
      ZStack {
        Color(white: 0.12)
        if let image = model.image {
          Image(uiImage: image)
            .resizable()
            .scaledToFill()
        } else {
          Image(systemName: "video")
            .font(.title2)
            .foregroundStyle(.secondary)
        }
      }
      .aspectRatio(16 / 9, contentMode: .fit)
      .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
      Text(model.title)
        .font(.headline)
      if !model.body.isEmpty {
        Text(model.body)
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
    }
  }
}
