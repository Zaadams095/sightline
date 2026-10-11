import AVFoundation
import CoreImage
import ExpoModulesCore
import UIKit
import Vision

/// "Blur faces and license plates" before sharing with neighbors. Everything runs on this
/// iPhone with Apple's Vision framework: faces with VNDetectFaceRectanglesRequest, plates as
/// short letter-and-number text found by VNRecognizeTextRequest. Found areas are pixelated and
/// blurred in a copy; the original is never changed.
///
/// Video: an AVVideoComposition runs each frame through Core Image. Detection runs about five
/// times a second and its boxes (padded) cover the frames in between; export is cancelable and
/// reports progress through `onRedactProgress`.
public class RedactModule: Module {
  private let lock = NSLock()
  private var sessions: [String: AVAssetExportSession] = [:]
  private var cancelled = Set<String>()

  public func definition() -> ModuleDefinition {
    Name("Redact")

    Events("onRedactProgress")

    /// Blurs faces and/or plates in a photo. Returns how many of each were covered.
    AsyncFunction("redactImage") { (input: String, output: String, faces: Bool, plates: Bool) -> [String: Int] in
      let inURL = try Redactor.fileURL(input)
      let outURL = try Redactor.fileURL(output)
      guard let image = CIImage(contentsOf: inURL, options: [.applyOrientationProperty: true]) else {
        throw Exception(name: "RedactError", description: "The photo couldn’t be opened.")
      }
      let found = Redactor.detect(image, faces: faces, plates: plates)
      let result = Redactor.cover(image, rects: found.rects)
      try Redactor.writeJPEG(result, to: outURL)
      return ["faces": found.faces, "plates": found.plates]
    }

    /// Saves one frame of a video as a JPEG (for sharing a still from a clip).
    AsyncFunction("frameAt") { (input: String, seconds: Double, output: String) in
      let asset = AVURLAsset(url: try Redactor.fileURL(input))
      let generator = AVAssetImageGenerator(asset: asset)
      generator.appliesPreferredTrackTransform = true
      let tolerance = CMTime(seconds: 0.5, preferredTimescale: 600)
      generator.requestedTimeToleranceBefore = tolerance
      generator.requestedTimeToleranceAfter = tolerance
      let cg = try generator.copyCGImage(at: CMTime(seconds: max(0, seconds), preferredTimescale: 600), actualTime: nil)
      try Redactor.writeJPEG(CIImage(cgImage: cg), to: try Redactor.fileURL(output))
    }

    /// Blurs faces and/or plates in a video into a new MP4. Throws "Cancelled" after cancel(jobId).
    AsyncFunction("redactVideo") { (jobId: String, input: String, output: String, faces: Bool, plates: Bool) -> [String: Int] in
      let inURL = try Redactor.fileURL(input)
      let outURL = try Redactor.fileURL(output)
      try? FileManager.default.removeItem(at: outURL)

      let asset = AVURLAsset(url: inURL)
      let frames = FrameRedactor(faces: faces, plates: plates)
      let composition = AVMutableVideoComposition(asset: asset, applyingCIFiltersWithHandler: { request in
        let source = request.sourceImage
        let out = frames.process(source, time: CMTimeGetSeconds(request.compositionTime))
        request.finish(with: out, context: nil)
      })
      guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetHighestQuality) else {
        throw Exception(name: "RedactError", description: "This video can’t be processed on this iPhone.")
      }
      session.outputURL = outURL
      session.outputFileType = .mp4
      session.shouldOptimizeForNetworkUse = true
      session.videoComposition = composition

      self.lock.lock()
      let alreadyCancelled = self.cancelled.remove(jobId) != nil
      if !alreadyCancelled { self.sessions[jobId] = session }
      self.lock.unlock()
      if alreadyCancelled {
        throw Exception(name: "Cancelled", description: "Cancelled.")
      }

      let done = DispatchSemaphore(value: 0)
      session.exportAsynchronously {
        done.signal()
      }
      while done.wait(timeout: .now() + 0.4) == .timedOut {
        self.sendEvent("onRedactProgress", ["jobId": jobId, "progress": Double(session.progress)])
      }

      self.lock.lock()
      self.sessions.removeValue(forKey: jobId)
      self.cancelled.remove(jobId)
      self.lock.unlock()

      switch session.status {
      case .completed:
        self.sendEvent("onRedactProgress", ["jobId": jobId, "progress": 1.0])
        return ["faces": frames.maxFaces, "plates": frames.maxPlates]
      case .cancelled:
        try? FileManager.default.removeItem(at: outURL)
        throw Exception(name: "Cancelled", description: "Cancelled.")
      default:
        try? FileManager.default.removeItem(at: outURL)
        let reason = session.error?.localizedDescription ?? "unknown error"
        throw Exception(name: "RedactError", description: "The video couldn’t be processed (\(reason)).")
      }
    }

    Function("cancel") { (jobId: String) in
      self.lock.lock()
      let session = self.sessions[jobId]
      if session == nil { self.cancelled.insert(jobId) }
      self.lock.unlock()
      session?.cancelExport()
    }
  }
}

/// Per-video detection state: re-detects a few times a second, reuses boxes in between.
final class FrameRedactor: @unchecked Sendable {
  private let faces: Bool
  private let plates: Bool
  private let lock = NSLock()
  private var lastDetect: Double = -1000
  private var rects: [CGRect] = []
  private(set) var maxFaces = 0
  private(set) var maxPlates = 0
  /// Seconds between detections.
  private let interval: Double = 0.2

  init(faces: Bool, plates: Bool) {
    self.faces = faces
    self.plates = plates
  }

  func process(_ image: CIImage, time: Double) -> CIImage {
    lock.lock()
    defer { lock.unlock() }
    if abs(time - lastDetect) >= interval {
      let found = Redactor.detect(image, faces: faces, plates: plates)
      rects = found.rects
      maxFaces = max(maxFaces, found.faces)
      maxPlates = max(maxPlates, found.plates)
      lastDetect = time
    }
    return Redactor.cover(image, rects: rects)
  }
}

enum Redactor {
  static func fileURL(_ s: String) throws -> URL {
    if s.hasPrefix("file://"), let u = URL(string: s) { return u }
    if s.hasPrefix("/") { return URL(fileURLWithPath: s) }
    throw Exception(name: "RedactError", description: "Not a file on this iPhone.")
  }

  /// Normalized (0–1, origin bottom-left) boxes to cover, padded so movement between
  /// detections stays covered.
  static func detect(_ image: CIImage, faces: Bool, plates: Bool) -> (rects: [CGRect], faces: Int, plates: Int) {
    var requests: [VNRequest] = []
    let faceRequest = VNDetectFaceRectanglesRequest()
    let textRequest = VNRecognizeTextRequest()
    textRequest.recognitionLevel = .fast
    textRequest.usesLanguageCorrection = false
    textRequest.minimumTextHeight = 0.01
    if faces { requests.append(faceRequest) }
    if plates { requests.append(textRequest) }
    if requests.isEmpty { return ([], 0, 0) }

    let handler = VNImageRequestHandler(ciImage: image, options: [:])
    do {
      try handler.perform(requests)
    } catch {
      return ([], 0, 0)
    }

    var rects: [CGRect] = []
    var faceCount = 0
    var plateCount = 0
    if faces {
      for face in faceRequest.results ?? [] {
        rects.append(pad(face.boundingBox, by: 0.35))
        faceCount += 1
      }
    }
    if plates {
      for text in textRequest.results ?? [] {
        guard let best = text.topCandidates(1).first, looksLikePlate(best.string) else { continue }
        let box = text.boundingBox
        // Plates are wider than tall; tall text boxes are signs or overlays.
        if box.height > 0 && box.width / box.height < 1.2 { continue }
        rects.append(pad(box, by: 0.3))
        plateCount += 1
      }
    }
    return (rects, faceCount, plateCount)
  }

  /// 4–8 letters and digits with at least two digits ("ABC 1234", "7XYZ123"), the way most
  /// plates read. Camera timestamps are longer and camera names have no digits.
  static func looksLikePlate(_ s: String) -> Bool {
    let chars = s.uppercased().filter { $0.isLetter || $0.isNumber }
    guard chars.count >= 4 && chars.count <= 8 else { return false }
    let digits = chars.filter { $0.isNumber }.count
    return digits >= 2
  }

  static func pad(_ r: CGRect, by fraction: CGFloat) -> CGRect {
    let dx = r.width * fraction
    let dy = r.height * fraction
    return r.insetBy(dx: -dx, dy: -dy).intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
  }

  /// Pixelates and blurs the given normalized areas of the image.
  static func cover(_ image: CIImage, rects: [CGRect]) -> CIImage {
    let extent = image.extent
    guard !rects.isEmpty, extent.width > 0, extent.height > 0 else { return image }
    let side = max(extent.width, extent.height)
    let hidden = image.clampedToExtent()
      .applyingFilter("CIPixellate", parameters: [kCIInputScaleKey: max(8, side / 45)])
      .applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: max(6, side / 90)])
      .cropped(to: extent)

    var mask = CIImage(color: CIColor(red: 0, green: 0, blue: 0)).cropped(to: extent)
    for r in rects {
      let px = CGRect(
        x: extent.origin.x + r.origin.x * extent.width,
        y: extent.origin.y + r.origin.y * extent.height,
        width: r.width * extent.width,
        height: r.height * extent.height
      )
      let white = CIImage(color: CIColor(red: 1, green: 1, blue: 1)).cropped(to: px)
      mask = white.composited(over: mask)
    }
    return hidden.applyingFilter("CIBlendWithMask", parameters: [
      kCIInputBackgroundImageKey: image,
      kCIInputMaskImageKey: mask,
    ]).cropped(to: extent)
  }

  static func writeJPEG(_ image: CIImage, to url: URL) throws {
    let context = CIContext()
    let space = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    guard let data = context.jpegRepresentation(of: image, colorSpace: space, options: [:]) else {
      throw Exception(name: "RedactError", description: "The photo couldn’t be saved.")
    }
    try? FileManager.default.removeItem(at: url)
    try data.write(to: url)
  }
}
