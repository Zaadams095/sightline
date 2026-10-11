import Foundation
import Security

/// Keychain items shared with the notification extension through the App Group.
/// A copy of this file lives in targets/notification-service; keep them identical.
enum SharedKeychain {
  static let service = "sightline.shared"

  static var accessGroup: String? {
    Bundle.main.object(forInfoDictionaryKey: "SightlineAppGroup") as? String
  }

  private static func baseQuery(_ account: String) -> [String: Any] {
    var q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    if let group = accessGroup { q[kSecAttrAccessGroup as String] = group }
    return q
  }

  static func set(_ account: String, _ value: String) {
    remove(account)
    var q = baseQuery(account)
    q[kSecValueData as String] = Data(value.utf8)
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(q as CFDictionary, nil)
  }

  static func get(_ account: String) -> String? {
    var q = baseQuery(account)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func remove(_ account: String) {
    SecItemDelete(baseQuery(account) as CFDictionary)
  }
}
