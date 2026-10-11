import ExpoModulesCore
import UIKit
import WatchConnectivity

/// Phone side of the Apple Watch link (WatchConnectivity).
///
/// - The camera list, recent alerts and doorbell state go to the watch as the application
///   context (latest value wins, delivered whenever the watch next wakes).
/// - The watch asks for snapshots with `sendMessage`; each request is handed to JS
///   (`onWatchRequest`), which fetches the image with the camera's own adapter (any brand),
///   and the downscaled JPEG goes back in the reply. If the watch stopped waiting, the image
///   is sent with `transferFile` instead.
/// - Hub sign-in for the watch's own fallback path travels once with `transferUserInfo`.
public class WatchBridgeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WatchBridge")

    Events("onWatchRequest")

    OnCreate {
      WatchLink.shared.onRequest = { [weak self] id, body in
        self?.sendEvent("onWatchRequest", ["id": id, "body": body])
      }
      WatchLink.shared.activate()
    }

    OnDestroy {
      WatchLink.shared.onRequest = nil
    }

    /// {supported, paired, installed, reachable}
    Function("status") { () -> [String: Bool] in
      WatchLink.shared.status()
    }

    AsyncFunction("updateContext") { (json: String) in
      try WatchLink.shared.updateContext(json)
    }

    AsyncFunction("sendCredentials") { (json: String) in
      WatchLink.shared.sendCredentials(json)
    }

    /// Answers a watch request with an image file (file:// URI), downscaled to `maxPixels`.
    AsyncFunction("replyImage") { (id: String, key: String, fileUri: String, maxPixels: Int) -> Bool in
      WatchLink.shared.replyImage(id: id, key: key, fileUri: fileUri, maxPixels: maxPixels)
    }

    /// Answers a watch request with a small message, e.g. ["ok": "1"] or ["error": "…"].
    Function("reply") { (id: String, message: [String: String]) in
      WatchLink.shared.reply(id, message)
    }

    /// Sends an image the watch didn't ask for (e.g. the doorbell snapshot when it rings).
    AsyncFunction("pushImage") { (key: String, fileUri: String, maxPixels: Int) -> Bool in
      WatchLink.shared.pushImage(key: key, fileUri: fileUri, maxPixels: maxPixels)
    }
  }
}

final class WatchLink: NSObject, WCSessionDelegate {
  static let shared = WatchLink()

  /// Messages over WatchConnectivity are limited to roughly 64 KB.
  private static let maxReplyBytes = 60_000

  var onRequest: ((String, String) -> Void)?

  private let lock = NSLock()
  private var pending: [String: ([String: Any]) -> Void] = [:]
  private var activated = false

  private var session: WCSession? {
    WCSession.isSupported() ? WCSession.default : nil
  }

  func activate() {
    guard let session else { return }
    lock.lock()
    let first = !activated
    activated = true
    lock.unlock()
    if first {
      session.delegate = self
      session.activate()
    }
  }

  func status() -> [String: Bool] {
    guard let session else {
      return ["supported": false, "paired": false, "installed": false, "reachable": false]
    }
    let active = session.activationState == .activated
    return [
      "supported": true,
      "paired": active && session.isPaired,
      "installed": active && session.isWatchAppInstalled,
      "reachable": active && session.isReachable,
    ]
  }

  func updateContext(_ json: String) throws {
    guard let session, session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return }
    try session.updateApplicationContext(["payload": json])
  }

  func sendCredentials(_ json: String) {
    guard let session, session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return }
    // Only the newest sign-in matters; drop older ones still waiting to be delivered.
    for transfer in session.outstandingUserInfoTransfers where transfer.userInfo["credentials"] != nil {
      transfer.cancel()
    }
    session.transferUserInfo(["credentials": json])
  }

  func reply(_ id: String, _ message: [String: Any]) {
    lock.lock()
    let handler = pending.removeValue(forKey: id)
    lock.unlock()
    handler?(message)
  }

  func replyImage(id: String, key: String, fileUri: String, maxPixels: Int) -> Bool {
    guard let data = Self.jpeg(fileUri: fileUri, maxPixels: maxPixels) else {
      reply(id, ["error": "no-image"])
      return false
    }
    lock.lock()
    let handler = pending.removeValue(forKey: id)
    lock.unlock()
    if let handler, data.count <= Self.maxReplyBytes {
      handler(["image": data, "key": key, "at": Date().timeIntervalSince1970])
      return true
    }
    handler?(["queued": true])
    return transfer(data, key: key)
  }

  func pushImage(key: String, fileUri: String, maxPixels: Int) -> Bool {
    guard let data = Self.jpeg(fileUri: fileUri, maxPixels: maxPixels) else { return false }
    return transfer(data, key: key)
  }

  private func transfer(_ data: Data, key: String) -> Bool {
    guard let session, session.activationState == .activated, session.isWatchAppInstalled else { return false }
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("watch-\(UUID().uuidString).jpg")
    do {
      try data.write(to: url)
    } catch {
      return false
    }
    session.transferFile(url, metadata: ["key": key, "at": Date().timeIntervalSince1970])
    return true
  }

  /// Small JPEG for the watch: longest side `maxPixels`, quality lowered until it fits a message.
  static func jpeg(fileUri: String, maxPixels: Int) -> Data? {
    let path = URL(string: fileUri)?.path ?? fileUri
    guard let image = UIImage(contentsOfFile: path), image.size.width > 0, image.size.height > 0 else { return nil }
    let longest = max(image.size.width, image.size.height)
    let scale = min(1, CGFloat(max(maxPixels, 64)) / longest)
    let size = CGSize(width: max(1, (image.size.width * scale).rounded()), height: max(1, (image.size.height * scale).rounded()))
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: size))
    }
    var quality: CGFloat = 0.7
    var data = resized.jpegData(compressionQuality: quality)
    while let d = data, d.count > maxReplyBytes, quality > 0.25 {
      quality -= 0.15
      data = resized.jpegData(compressionQuality: quality)
    }
    return data
  }

  // MARK: - WCSessionDelegate

  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}

  func sessionDidBecomeInactive(_ session: WCSession) {}

  func sessionDidDeactivate(_ session: WCSession) {
    // The user switched to another watch: start talking to the new one.
    session.activate()
  }

  func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
    guard let onRequest else {
      replyHandler(["error": "phone-app-starting"])
      return
    }
    let id = UUID().uuidString
    lock.lock()
    pending[id] = replyHandler
    lock.unlock()
    // The watch gives up after a while; don't hold on to its handler forever.
    DispatchQueue.global().asyncAfter(deadline: .now() + 30) { [weak self] in
      self?.reply(id, ["error": "timeout"])
    }
    let body = (try? JSONSerialization.data(withJSONObject: Self.jsonSafe(message))).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    onRequest(id, body)
  }

  func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    guard let onRequest else { return }
    let body = (try? JSONSerialization.data(withJSONObject: Self.jsonSafe(message))).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    onRequest("", body)
  }

  /// Keeps only values JSON can carry (messages from the watch are small dictionaries).
  private static func jsonSafe(_ message: [String: Any]) -> [String: Any] {
    message.filter { _, v in v is String || v is NSNumber || v is Bool }
  }
}
