import CryptoKit
import UserNotifications

/// Adds a snapshot to Instant Alerts pushes.
///
/// 1. On the home network, it fetches a full-size frame from the bridge (/snapshot/<camera>).
/// 2. Otherwise it decrypts the tiny inline thumbnail the bridge embedded in the push
///    (AES-GCM, key = SHA256("sightline-thumb-v1:" + bridge secret)); see bridge/thumb.go.
/// If both fail, the text-only notification is delivered unchanged.
///
/// Newer Hubs seal the words too (bridge/seal.go, "enc-msg-v1"): Apple and Expo only see
/// "Activity on your cameras", and the real title, body, thread and data travel in data.enc
/// (AES-GCM, key = SHA256("sightline-msg-v1:" + secret)). This opens it first and puts it all
/// back, so the app's tap handling gets the same data as before.
///
/// Newer Hubs seal the words too (bridge/seal.go, "enc-msg-v1"): Apple and Expo only see
/// "Activity on your cameras", and the real title, body, thread and data travel in data.enc
/// (AES-GCM, key = SHA256("sightline-msg-v1:" + secret)). This opens it first and puts it all
/// back, so the app's tap handling gets the same data as before.
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

    var data = Self.payloadData(content.userInfo)
    let secret = SharedKeychain.get("bridge.secret")
    var sealedThread: String?
    if let enc = data["enc"] as? String, let secret, let opened = Self.openMessage(enc, secret: secret) {
      if let title = opened["title"] as? String { content.title = title }
      content.body = (opened["body"] as? String) ?? ""
      if let extra = opened["data"] as? [String: Any] {
        for (key, value) in extra { data[key] = value }
      }
      data.removeValue(forKey: "enc")
      sealedThread = opened["threadId"] as? String
      // expo-notifications reads a remote notification's data from userInfo["body"].
      var info = content.userInfo
      info["body"] = data
      content.userInfo = info
    }
    let camera = data["cameraId"] as? String
    if let system = data["systemId"] as? String, let camera {
      content.threadIdentifier = "\(system):\(camera)"
    }
    if let sealedThread, !sealedThread.isEmpty {
      content.threadIdentifier = sealedThread
    }
    let thumbB64 = data["thumb"] as? String

    Task {
      var image: Data?
      if let camera, let secret, let base = SharedKeychain.get("bridge.url") {
        image = await Self.fetchFullSnapshot(base: base, camera: camera, secret: secret)
      }
      if image == nil, let thumb = thumbB64, let secret {
        image = Self.openThumb(thumb, secret: secret)
      }
      if let image, let attachment = Self.attachment(image, id: request.identifier) {
        content.attachments = [attachment]
      }
      // Familiar faces / plates the user named in the app ("Dad is at Front Door"), on-device.
      if let image, let name = FamiliarMatcher.recognize(imageData: image) {
        content.title = FamiliarMatcher.title(content.title, name: name)
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

  /// The sealed title/body/thread/data of a push (bridge/seal.go), or nil.
  static func openMessage(_ b64: String, secret: String) -> [String: Any]? {
    guard let raw = Data(base64Encoded: b64) else { return nil }
    let key = SymmetricKey(data: SHA256.hash(data: Data("sightline-msg-v1:\(secret)".utf8)))
    guard let box = try? AES.GCM.SealedBox(combined: raw),
          let plain = try? AES.GCM.open(box, using: key),
          let object = try? JSONSerialization.jsonObject(with: plain) as? [String: Any],
          (object["v"] as? Int) == 1 else { return nil }
    return object
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
