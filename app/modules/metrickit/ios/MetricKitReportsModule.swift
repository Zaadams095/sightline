import ExpoModulesCore
import Foundation
import MetricKit

/// Receives MetricKit diagnostic payloads (crashes, hangs, CPU and disk-write exceptions) that
/// iOS delivers to the app, and keeps the newest few as JSON files in Application Support.
/// Nothing is sent anywhere: the JS side only reads them when the user builds a problem report.
final class MetricKitCollector: NSObject, MXMetricManagerSubscriber, @unchecked Sendable {
  static let shared = MetricKitCollector()
  static let maxFiles = 20

  private let lock = NSLock()
  private var subscribed = false

  func subscribe() {
    lock.lock()
    let first = !subscribed
    subscribed = true
    lock.unlock()
    if first {
      MXMetricManager.shared.add(self)
    }
  }

  // MXMetricManagerSubscriber
  func didReceive(_ payloads: [MXDiagnosticPayload]) {
    save(payloads)
  }

  private var folder: URL? {
    guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
      return nil
    }
    return base.appendingPathComponent("MetricKit", isDirectory: true)
  }

  /// Newest first (file names start with the payload's end time).
  private func files(in dir: URL) -> [URL] {
    let urls = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
    return urls
      .filter { $0.pathExtension == "json" }
      .sorted { $0.lastPathComponent > $1.lastPathComponent }
  }

  func save(_ payloads: [MXDiagnosticPayload]) {
    guard let dir = folder, !payloads.isEmpty else { return }
    lock.lock()
    defer { lock.unlock() }
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    for payload in payloads {
      let data = payload.jsonRepresentation()
      let stamp = Int(payload.timeStampEnd.timeIntervalSince1970)
      // Same payload delivered twice (live and again from pastDiagnosticPayloads) keeps one file.
      let url = dir.appendingPathComponent("diag-\(stamp)-\(data.count).json")
      if FileManager.default.fileExists(atPath: url.path) { continue }
      try? data.write(to: url, options: .atomic)
    }
    for old in files(in: dir).dropFirst(MetricKitCollector.maxFiles) {
      try? FileManager.default.removeItem(at: old)
    }
  }

  func read(limit: Int) -> [String] {
    guard let dir = folder else { return [] }
    lock.lock()
    defer { lock.unlock() }
    var out: [String] = []
    for url in files(in: dir).prefix(max(0, limit)) {
      if let text = try? String(contentsOf: url, encoding: .utf8) {
        out.append(text)
      }
    }
    return out
  }

  func clear() {
    guard let dir = folder else { return }
    lock.lock()
    defer { lock.unlock() }
    try? FileManager.default.removeItem(at: dir)
  }
}

public class MetricKitReportsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MetricKitReports")

    OnCreate {
      MetricKitCollector.shared.subscribe()
    }

    /// Saves anything iOS has delivered since the last launch, then returns up to `limit`
    /// stored payloads (MXDiagnosticPayload JSON), newest first.
    AsyncFunction("collect") { (limit: Int) -> [String] in
      let collector = MetricKitCollector.shared
      collector.subscribe()
      collector.save(MXMetricManager.shared.pastDiagnosticPayloads)
      return collector.read(limit: limit)
    }

    AsyncFunction("clear") {
      MetricKitCollector.shared.clear()
    }
  }
}
