import ExpoModulesCore
import WidgetKit

/// Writes into the App Group container shared with the widget and App Intents extensions,
/// and asks WidgetKit to refresh. The group id comes from Info.plist (SightlineAppGroup).
public class AppGroupModule: Module {
  private var container: URL? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "SightlineAppGroup") as? String else { return nil }
    return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
  }

  private func target(_ relPath: String) throws -> URL {
    guard let base = container else { throw Exception(name: "AppGroup", description: "App Group container unavailable") }
    let url = base.appendingPathComponent(relPath)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    return url
  }

  private static func exclude(_ target: URL) throws {
    guard FileManager.default.fileExists(atPath: target.path) else { return }
    var url = target
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
  }

  public func definition() -> ModuleDefinition {
    Name("AppGroup")

    AsyncFunction("writeText") { (relPath: String, text: String) in
      try Data(text.utf8).write(to: try self.target(relPath), options: .atomic)
    }

    /// Copies a local file (file:// URI, e.g. a downloaded snapshot) into the container.
    AsyncFunction("copyFile") { (fromUri: String, relPath: String) in
      guard let src = URL(string: fromUri) else { throw Exception(name: "AppGroup", description: "Bad file URI") }
      let dest = try self.target(relPath)
      try? FileManager.default.removeItem(at: dest)
      try FileManager.default.copyItem(at: src, to: dest)
    }

    AsyncFunction("readText") { (relPath: String) -> String? in
      guard let base = self.container else { return nil }
      return try? String(contentsOf: base.appendingPathComponent(relPath), encoding: .utf8)
    }

    AsyncFunction("removeFile") { (relPath: String) in
      guard let base = self.container else { return }
      try? FileManager.default.removeItem(at: base.appendingPathComponent(relPath))
    }

    /// Keeps a file or folder in the app's own storage (file:// URI) out of iCloud and computer
    /// backups of the iPhone. On a folder it covers everything inside, added later too. Used
    /// for familiar faces (feature prints and crops), which stay on this iPhone only.
    AsyncFunction("excludeFromBackup") { (uri: String) in
      let parsed: URL? = uri.hasPrefix("file://") ? URL(string: uri) : URL(fileURLWithPath: uri)
      guard let target = parsed else {
        throw Exception(name: "AppGroup", description: "Bad file URI")
      }
      try AppGroupModule.exclude(target)
    }

    /// The same for a path in the App Group container (e.g. "familiar").
    AsyncFunction("excludeGroupPathFromBackup") { (relPath: String) in
      guard let base = self.container else { return }
      try AppGroupModule.exclude(base.appendingPathComponent(relPath))
    }

    Function("reloadWidgets") {
      WidgetCenter.shared.reloadAllTimelines()
    }
  }
}
