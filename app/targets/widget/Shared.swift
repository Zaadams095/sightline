import AppIntents
import Foundation
import UIKit

// Data the app writes into the App Group (see app/src/widgets/sync.ts).
// Identical copies live in targets/widget and targets/intents; keep them in sync.

struct SharedCamera: Codable, Hashable {
  let key: String
  let name: String
  /// Path of the latest snapshot, relative to the App Group container.
  let image: String?
  /// Unix seconds when the snapshot was saved.
  let updatedAt: Double?
}

struct LastAlert: Codable {
  let title: String
  let camera: String
  let key: String
  let time: Double
}

enum Shared {
  static var container: URL? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "SightlineAppGroup") as? String else { return nil }
    return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
  }

  static func cameras() -> [SharedCamera] { read("widget/cameras.json") ?? [] }
  static func lastAlert() -> LastAlert? { read("widget/last-alert.json") }

  static func image(_ relPath: String?) -> UIImage? {
    guard let relPath, let base = container else { return nil }
    return UIImage(contentsOfFile: base.appendingPathComponent(relPath).path)
  }

  /// sightline://camera/<key>, opened by the app's router.
  static func cameraURL(_ key: String) -> URL {
    let encoded = key.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? key
    return URL(string: "sightline://camera/\(encoded)")!
  }

  private static func read<T: Decodable>(_ relPath: String) -> T? {
    guard let base = container, let data = try? Data(contentsOf: base.appendingPathComponent(relPath)) else { return nil }
    return try? JSONDecoder().decode(T.self, from: data)
  }
}

struct CameraEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Camera"
  static let defaultQuery = CameraQuery()

  let id: String
  let name: String

  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct CameraQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [CameraEntity] {
    Shared.cameras().filter { identifiers.contains($0.key) }.map { CameraEntity(id: $0.key, name: $0.name) }
  }

  func suggestedEntities() async throws -> [CameraEntity] {
    Shared.cameras().map { CameraEntity(id: $0.key, name: $0.name) }
  }
}
