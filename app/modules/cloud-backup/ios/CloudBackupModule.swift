import CoreImage
import CoreImage.CIFilterBuiltins
import ExpoModulesCore
import Foundation
import Security
import UIKit

/// iCloud backup and "move to a new phone" plumbing. Apple's own iCloud only, no Sightline server.
///
/// - Settings: iCloud key-value storage (NSUbiquitousKeyValueStore). Needs the
///   com.apple.developer.ubiquity-kvstore-identifier entitlement; without it writes stay local.
/// - Secrets: iCloud Keychain items (kSecAttrSynchronizable) in the app's own keychain group,
///   service "sightline.sync". Separate from the App Group items the notification extension
///   reads ("sightline.shared"), which stay on this device only.
/// - QR codes for the phone-to-phone transfer (Core Image).
public class CloudBackupModule: Module {
  private static let syncService = "sightline.sync"
  private var kvObserver: NSObjectProtocol?

  private var kv: NSUbiquitousKeyValueStore { NSUbiquitousKeyValueStore.default }

  private static func syncQuery(_ account: String?) -> [String: Any] {
    var q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: syncService,
      kSecAttrSynchronizable as String: true,
    ]
    if let account { q[kSecAttrAccount as String] = account }
    return q
  }

  public func definition() -> ModuleDefinition {
    Name("CloudBackup")

    Events("onCloudChange")

    OnStartObserving {
      if self.kvObserver != nil { return }
      self.kvObserver = NotificationCenter.default.addObserver(
        forName: NSUbiquitousKeyValueStore.didChangeExternallyNotification,
        object: NSUbiquitousKeyValueStore.default,
        queue: .main
      ) { [weak self] note in
        let reason = note.userInfo?[NSUbiquitousKeyValueStoreChangeReasonKey] as? Int ?? -1
        let keys = note.userInfo?[NSUbiquitousKeyValueStoreChangedKeysKey] as? [String] ?? []
        self?.sendEvent("onCloudChange", ["reason": reason, "keys": keys])
      }
      NSUbiquitousKeyValueStore.default.synchronize()
    }

    OnStopObserving {
      if let observer = self.kvObserver { NotificationCenter.default.removeObserver(observer) }
      self.kvObserver = nil
    }

    /// True when an iCloud account is signed in on this device.
    Function("isSignedIn") { () -> Bool in
      FileManager.default.ubiquityIdentityToken != nil
    }

    // MARK: Key-value storage

    Function("kvSynchronize") { () -> Bool in
      self.kv.synchronize()
    }

    Function("kvGet") { (key: String) -> String? in
      self.kv.string(forKey: key)
    }

    Function("kvSet") { (key: String, value: String) in
      self.kv.set(value, forKey: key)
    }

    Function("kvRemove") { (key: String) in
      self.kv.removeObject(forKey: key)
    }

    Function("kvKeys") { () -> [String] in
      Array(self.kv.dictionaryRepresentation.keys)
    }

    // MARK: iCloud Keychain

    AsyncFunction("syncSecretGet") { (account: String) -> String? in
      var q = Self.syncQuery(account)
      q[kSecReturnData as String] = true
      q[kSecMatchLimit as String] = kSecMatchLimitOne
      var out: CFTypeRef?
      guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
      return String(data: data, encoding: .utf8)
    }

    AsyncFunction("syncSecretSet") { (account: String, value: String) in
      let q = Self.syncQuery(account)
      let data = Data(value.utf8)
      var status = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
      if status == errSecItemNotFound {
        var add = q
        add[kSecValueData as String] = data
        // Synchronizable items can't be "ThisDeviceOnly"; after-first-unlock matches how the
        // app reads secrets in the background.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        status = SecItemAdd(add as CFDictionary, nil)
      }
      if status != errSecSuccess {
        throw Exception(name: "CloudKeychain", description: "Keychain error \(status)")
      }
    }

    AsyncFunction("syncSecretRemove") { (account: String) in
      _ = SecItemDelete(Self.syncQuery(account) as CFDictionary)
    }

    AsyncFunction("syncSecretAccounts") { () -> [String] in
      var q = Self.syncQuery(nil)
      q[kSecReturnAttributes as String] = true
      q[kSecMatchLimit as String] = kSecMatchLimitAll
      var out: CFTypeRef?
      guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
            let items = out as? [[String: Any]] else { return [] }
      return items.compactMap { $0[kSecAttrAccount as String] as? String }
    }

    // MARK: QR code

    /// A crisp black-on-white QR code as a data: URI (PNG).
    AsyncFunction("qrPng") { (text: String) -> String in
      let filter = CIFilter.qrCodeGenerator()
      filter.message = Data(text.utf8)
      filter.correctionLevel = "M"
      guard let small = filter.outputImage else {
        throw Exception(name: "QRCode", description: "Couldn't make the QR code")
      }
      let scale = max(1, (600 / max(small.extent.width, 1)).rounded(.down))
      let image = small.samplingNearest().transformed(by: CGAffineTransform(scaleX: scale, y: scale))
      guard let cg = CIContext().createCGImage(image, from: image.extent),
            let png = UIImage(cgImage: cg).pngData() else {
        throw Exception(name: "QRCode", description: "Couldn't make the QR code")
      }
      return "data:image/png;base64," + png.base64EncodedString()
    }
  }
}
