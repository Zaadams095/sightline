import Foundation
import Security
import SwiftUI
import UIKit
import WatchConnectivity

// What the phone sends (app/src/watch/context.ts). Keep the two in sync.

struct WCamera: Codable, Hashable {
  let key: String
  /// The camera's id on its system (for a Hub: the Hub's camera id).
  let id: String
  let name: String
  let doorbell: Bool
  /// Set when the camera comes from a Sightline Hub (that Hub's system id).
  let hub: String?
}

struct WAlert: Codable, Hashable, Identifiable {
  let id: String
  let key: String
  let title: String
  let camera: String
  let time: Double
  let doorbell: Bool

  var date: Date { Date(timeIntervalSince1970: time) }
}

struct WHub: Codable, Hashable {
  let id: String
  let name: String
  let lanUrl: String
  let remoteUrl: String
}

struct WContext: Codable {
  let v: Int
  let cameras: [WCamera]
  let alerts: [WAlert]
  let ring: WAlert?
  let hubs: [WHub]
  let updatedAt: Double
}

struct Snapshot {
  let image: UIImage
  let at: Date
}

/// Everything the watch shows. Snapshots come from the phone (which reaches every brand,
/// at home or over its VPN); when the phone is out of reach, Hub cameras are fetched from the
/// Hub's public link with the sign-in the phone handed over.
final class WatchStore: NSObject, ObservableObject, WCSessionDelegate {
  static let shared = WatchStore()

  @Published var context: WContext?
  @Published var snapshots: [String: Snapshot] = [:]
  @Published var phoneReachable = false
  /// The ring currently shown full screen.
  @Published var presentedRing: WAlert?

  private var dismissedRings = Set<String>()
  private var inFlight = Set<String>()

  static let ringFreshSeconds: TimeInterval = 180

  func activate() {
    guard WCSession.isSupported() else { return }
    let session = WCSession.default
    session.delegate = self
    session.activate()
  }

  var cameras: [WCamera] { context?.cameras ?? [] }
  var alerts: [WAlert] { context?.alerts ?? [] }

  func camera(_ key: String) -> WCamera? { cameras.first { $0.key == key } }

  /// Asks the phone to send fresh data now (e.g. pull to refresh, app opened).
  func refresh() {
    guard WCSession.isSupported(), WCSession.default.activationState == .activated, WCSession.default.isReachable else { return }
    WCSession.default.sendMessage(["type": "refresh"], replyHandler: { _ in }, errorHandler: { _ in })
  }

  func dismissRing() {
    if let ring = presentedRing { dismissedRings.insert(ring.id) }
    presentedRing = nil
  }

  // MARK: - Snapshots

  /// Fetches a fresh snapshot (phone first, then the Hub). Returns whether one arrived.
  @discardableResult
  func loadSnapshot(_ key: String, size: Int) async -> Bool {
    let busy = await MainActor.run { () -> Bool in
      if inFlight.contains(key) { return true }
      inFlight.insert(key)
      return false
    }
    if busy { return false }
    defer { Task { @MainActor in self.inFlight.remove(key) } }

    var fetched = await fromPhone(key, size: size)
    if fetched == nil { fetched = await fromHub(key, size: size) }
    guard let image = fetched else { return false }
    await MainActor.run { self.snapshots[key] = Snapshot(image: image, at: Date()) }
    return true
  }

  private func fromPhone(_ key: String, size: Int) async -> UIImage? {
    guard WCSession.isSupported() else { return nil }
    let session = WCSession.default
    guard session.activationState == .activated, session.isReachable else { return nil }
    return await withCheckedContinuation { (cont: CheckedContinuation<UIImage?, Never>) in
      let once = Once()
      session.sendMessage(
        ["type": "snapshot", "key": key, "size": size],
        replyHandler: { reply in
          let image = (reply["image"] as? Data).flatMap { UIImage(data: $0) }
          once.run { cont.resume(returning: image) }
        },
        errorHandler: { _ in once.run { cont.resume(returning: nil) } }
      )
    }
  }

  private func fromHub(_ key: String, size: Int) async -> UIImage? {
    guard let ctx = context, let cam = ctx.cameras.first(where: { $0.key == key }), let hubId = cam.hub,
          let hub = ctx.hubs.first(where: { $0.id == hubId }), let token = HubKeychain.token(hubId) else { return nil }
    guard let id = cam.id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return nil }
    // The public link works anywhere; the home address only on the home Wi-Fi.
    for base in [hub.remoteUrl, hub.lanUrl] where !base.isEmpty {
      guard let url = URL(string: "\(base)/v1/cameras/\(id)/snapshot.jpg?height=\(size > 240 ? 480 : 240)") else { continue }
      var req = URLRequest(url: url, timeoutInterval: 8)
      req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      if let (data, resp) = try? await URLSession.shared.data(for: req),
         (resp as? HTTPURLResponse)?.statusCode == 200, let image = UIImage(data: data) {
        return image
      }
    }
    return nil
  }

  // MARK: - Context

  private func apply(_ payload: Any?) {
    guard let json = payload as? String, let data = json.data(using: .utf8),
          let ctx = try? JSONDecoder().decode(WContext.self, from: data) else { return }
    DispatchQueue.main.async {
      self.context = ctx
      if let ring = ctx.ring, !self.dismissedRings.contains(ring.id),
         Date().timeIntervalSince(ring.date) < Self.ringFreshSeconds {
        self.presentedRing = ring
      }
    }
  }

  // MARK: - WCSessionDelegate

  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    apply(session.receivedApplicationContext["payload"])
    let reachable = session.isReachable
    DispatchQueue.main.async { self.phoneReachable = reachable }
  }

  func sessionReachabilityDidChange(_ session: WCSession) {
    let reachable = session.isReachable
    DispatchQueue.main.async { self.phoneReachable = reachable }
  }

  func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
    apply(applicationContext["payload"])
  }

  func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
    guard let json = userInfo["credentials"] as? String, let data = json.data(using: .utf8),
          let creds = try? JSONDecoder().decode(Credentials.self, from: data) else { return }
    HubKeychain.replaceAll(creds.hubs.map { ($0.id, $0.token) })
  }

  /// A snapshot the phone sent as a file (too big for a reply, or a doorbell ring).
  func session(_ session: WCSession, didReceive file: WCSessionFile) {
    // The file is deleted when this returns, so read it now.
    guard let key = file.metadata?["key"] as? String, let data = try? Data(contentsOf: file.fileURL),
          let image = UIImage(data: data) else { return }
    DispatchQueue.main.async { self.snapshots[key] = Snapshot(image: image, at: Date()) }
  }
}

private struct Credentials: Codable {
  struct Hub: Codable {
    let id: String
    let token: String
  }
  let hubs: [Hub]
}

/// Resumes a continuation at most once (WatchConnectivity may call either handler).
private final class Once {
  private let lock = NSLock()
  private var done = false

  func run(_ body: () -> Void) {
    lock.lock()
    let first = !done
    done = true
    lock.unlock()
    if first { body() }
  }
}

/// Hub sign-ins on the watch, in the watch's own keychain (never in the shared context).
enum HubKeychain {
  private static let service = "sightline.watch.hub"

  private static func query(_ account: String? = nil) -> [String: Any] {
    var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
    if let account { q[kSecAttrAccount as String] = account }
    return q
  }

  static func token(_ hubId: String) -> String? {
    var q = query(hubId)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func replaceAll(_ items: [(String, String)]) {
    SecItemDelete(query() as CFDictionary)
    for (hubId, token) in items {
      var q = query(hubId)
      q[kSecValueData as String] = Data(token.utf8)
      q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      SecItemAdd(q as CFDictionary, nil)
    }
  }
}
