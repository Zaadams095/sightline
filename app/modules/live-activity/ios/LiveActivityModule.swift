import ActivityKit
import ExpoModulesCore
import UIKit

/// Must match targets/widget/LiveActivity.swift exactly (same type name and fields):
/// ActivityKit pairs the app's activity with the widget's layout by this type.
struct SightlineActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    /// "Someone's at the door", "Person", …
    var headline: String
    /// Small JPEG, relative to the App Group container (see saveImage).
    var image: String?
    /// Unix seconds when the ring / event began; drives the elapsed timer.
    var since: Double
    var ended: Bool
  }

  /// "doorbell" or "event".
  var kind: String
  /// Dedupes: one activity per ring / per camera event.
  var key: String
  var camera: String
  /// sightline:// link opened by a tap or the Watch button.
  var url: String
}

struct ActivityStateRecord: Record {
  @Field var headline: String = ""
  @Field var image: String? = nil
  @Field var since: Double = 0
  @Field var ended: Bool = false

  var state: SightlineActivityAttributes.ContentState {
    .init(headline: headline, image: image, since: since, ended: ended)
  }
}

struct ActivityStartRecord: Record {
  @Field var kind: String = "event"
  @Field var key: String = ""
  @Field var camera: String = ""
  @Field var url: String = "sightline://"
  @Field var state: ActivityStateRecord = ActivityStateRecord()
  /// Ends (and removes) the activity this long after it starts, if nothing ends it sooner.
  @Field var maxSeconds: Double = 300
}

public class LiveActivityModule: Module {
  private typealias SightlineActivity = Activity<SightlineActivityAttributes>

  private var container: URL? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "SightlineAppGroup") as? String else { return nil }
    return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
  }

  private static func find(_ id: String) -> SightlineActivity? {
    SightlineActivity.activities.first { $0.id == id }
  }

  public func definition() -> ModuleDefinition {
    Name("LiveActivity")

    /// False when the user turned Live Activities off for the app in iOS Settings.
    Function("isEnabled") { () -> Bool in
      ActivityAuthorizationInfo().areActivitiesEnabled
    }

    /// Running activities as [{ id, key, kind }].
    Function("list") { () -> [[String: String]] in
      SightlineActivity.activities.map { ["id": $0.id, "key": $0.attributes.key, "kind": $0.attributes.kind] }
    }

    /// Starts an activity, or updates the running one with the same key. Returns its id.
    /// iOS only allows starting while the app is in the foreground; otherwise this throws.
    AsyncFunction("start") { (opts: ActivityStartRecord) async throws -> String in
      let state = opts.state.state
      let stale = Date().addingTimeInterval(max(30, opts.maxSeconds))
      if let running = SightlineActivity.activities.first(where: { $0.attributes.key == opts.key }) {
        await running.update(ActivityContent(state: state, staleDate: stale))
        return running.id
      }
      let attributes = SightlineActivityAttributes(kind: opts.kind, key: opts.key, camera: opts.camera, url: opts.url)
      let activity = try SightlineActivity.request(
        attributes: attributes,
        content: ActivityContent(state: state, staleDate: stale, relevanceScore: opts.kind == "doorbell" ? 100 : 50),
        pushType: nil
      )
      let id = activity.id
      let seconds = max(30, opts.maxSeconds)
      // Best effort while the app stays alive; endStale() catches the rest on the next launch.
      Task {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        if let a = SightlineActivity.activities.first(where: { $0.id == id }) {
          await a.end(nil, dismissalPolicy: .immediate)
        }
      }
      return id
    }

    AsyncFunction("update") { (id: String, state: ActivityStateRecord) async in
      guard let activity = LiveActivityModule.find(id) else { return }
      await activity.update(ActivityContent(state: state.state, staleDate: activity.content.staleDate))
    }

    /// Ends one activity. With a final state it stays on the Lock Screen for `dismissAfterSec`.
    AsyncFunction("end") { (id: String, state: ActivityStateRecord?, dismissAfterSec: Double) async in
      guard let activity = LiveActivityModule.find(id) else { return }
      let content: ActivityContent<SightlineActivityAttributes.ContentState>? = state.map { ActivityContent(state: $0.state, staleDate: nil) }
      let policy: ActivityUIDismissalPolicy =
        dismissAfterSec <= 0 ? .immediate : .after(Date().addingTimeInterval(dismissAfterSec))
      await activity.end(content, dismissalPolicy: policy)
    }

    AsyncFunction("endAll") { () async in
      for activity in SightlineActivity.activities {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
    }

    /// Ends activities past their time (the app may have been suspended when they were due).
    AsyncFunction("endStale") { () async in
      let now = Date()
      for activity in SightlineActivity.activities {
        if let stale = activity.content.staleDate, stale <= now {
          await activity.end(nil, dismissalPolicy: .immediate)
        }
      }
    }

    /// Downscales a local image (file:// URI) into a small JPEG in the App Group, where the
    /// Live Activity can read it. Returns the relative path, or nil if the image is unreadable.
    AsyncFunction("saveImage") { (fromUri: String, relPath: String, maxSide: Double) throws -> String? in
      guard let base = self.container else { return nil }
      let path = URL(string: fromUri)?.path ?? fromUri
      guard let image = UIImage(contentsOfFile: path), image.size.width > 0, image.size.height > 0 else { return nil }
      let scale = min(1, CGFloat(maxSide) / max(image.size.width, image.size.height))
      let size = CGSize(width: floor(image.size.width * scale), height: floor(image.size.height * scale))
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      format.opaque = true
      let small = UIGraphicsImageRenderer(size: size, format: format).image { _ in
        image.draw(in: CGRect(origin: .zero, size: size))
      }
      guard let data = small.jpegData(compressionQuality: 0.6) else { return nil }
      let dest = base.appendingPathComponent(relPath)
      let dir = dest.deletingLastPathComponent()
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      // Drop pictures from activities that are long gone.
      if let old = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) {
        let cutoff = Date().addingTimeInterval(-3 * 3600)
        for file in old {
          let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
          if let modified, modified < cutoff { try? FileManager.default.removeItem(at: file) }
        }
      }
      try data.write(to: dest, options: .atomic)
      return relPath
    }
  }
}
