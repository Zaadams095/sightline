import CryptoKit
import UserNotifications

/// Adds a snapshot to Instant Alerts pushes.
///
/// 1. On the home network, it fetches a full-size frame from the bridge (/snapshot/<camera>).
/// 2. Otherwise it decrypts the tiny inline thumbnail the bridge embedded in the push
///    (AES-GCM, key = SHA256("sightline-thumb-v1:" + bridge secret)); see bridge/thumb.go.
/// If both fail, the text-only notification is delivered unchanged.
class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var content: UNMutableNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
      contentHandler(request.content)
      return
    }
    self.content = content

    let data = Self.payloadData(content.userInfo)
    let camera = data["cameraId"] as? String
    let secret = SharedKeychain.get("bridge.secret")
    if let system = data["systemId"] as? String, let camera {
      content.threadIdentifier = "\(system):\(camera)"
    }

    Task {
      var image: Data?
      if let camera, let secret, let base = SharedKeychain.get("bridge.url") {
        image = await Self.fetchFullSnapshot(base: base, camera: camera, secret: secret)
      }
      if image == nil, let thumb = data["thumb"] as? String, let secret {
        image = Self.openThumb(thumb, secret: secret)
      }
      if let image, let attachment = Self.attachment(image, id: request.identifier) {
        content.attachments = [attachment]
      }
      contentHandler(content)
    }
  }

  override func serviceExtensionTimeWillExpire() {
    if let contentHandler, let content { contentHandler(content) }
  }

  /// Expo delivers custom data under "body" (dictionary or JSON string); older payloads use "data".
  static func payloadData(_ userInfo: [AnyHashable: Any]) -> [String: Any] {
    for key in ["body", "data"] {
      if let dict = userInfo[key] as? [String: Any] { return dict }
      if let s = userInfo[key] as? String, let d = s.data(using: .utf8),
         let dict = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { return dict }
    }
    return [:]
  }

  static func openThumb(_ b64: String, secret: String) -> Data? {
    guard let raw = Data(base64Encoded: b64) else { return nil }
    let key = SymmetricKey(data: SHA256.hash(data: Data("sightline-thumb-v1:\(secret)".utf8)))
    guard let box = try? AES.GCM.SealedBox(combined: raw) else { return nil }
    return try? AES.GCM.open(box, using: key)
  }

  /// Only works on the home network (the extension has no VPN); fails fast otherwise.
  static func fetchFullSnapshot(base: String, camera: String, secret: String) async -> Data? {
    guard let escaped = camera.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
          let url = URL(string: "\(base)/snapshot/\(escaped)") else { return nil }
    var req = URLRequest(url: url, timeoutInterval: 3)
    req.setValue(secret, forHTTPHeaderField: "X-Bridge-Secret")
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForResource = 4
    guard let (data, resp) = try? await URLSession(configuration: config).data(for: req),
          (resp as? HTTPURLResponse)?.statusCode == 200, !data.isEmpty else { return nil }
    return data
  }

  static func attachment(_ data: Data, id: String) -> UNNotificationAttachment? {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(id).jpg")
    do {
      try data.write(to: url)
      return try UNNotificationAttachment(identifier: "snapshot", url: url, options: nil)
    } catch {
      return nil
    }
  }
}
