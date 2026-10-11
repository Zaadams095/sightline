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

    Function("reloadWidgets") {
      WidgetCenter.shared.reloadAllTimelines()
    }
  }
}
