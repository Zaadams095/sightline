import CoreGraphics
import ExpoModulesCore
import Foundation
import ImageIO
import UIKit
import Vision

struct AnalyzeOptionsRecord: Record {
  @Field var faces: Bool = true
  @Field var vehicles: Bool = false
  @Field var plates: Bool = true
  @Field var cropDir: String? = nil
  @Field var maxFaces: Int = 4
  @Field var minFacePx: Double = 40
}

/// Familiar faces & vehicles, on this iPhone only (Apple Vision; no network, no third-party AI).
///
/// Apple has no public face-recognition API, so this produces a general-purpose image feature
/// print (VNGenerateImageFeaturePrintRequest) of each upright, roughly frontal face crop, and of
/// the most salient object for vehicles, plus on-device text recognition for plates. Matching
/// (cosine similarity with conservative thresholds) happens in JS: src/familiar/match.ts.
public class SightlineVisionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SightlineVision")

    // Runs on the module's background queue, never the main thread.
    AsyncFunction("analyze") { (fileUri: String, options: AnalyzeOptionsRecord) throws -> [String: Any] in
      var result: [String: Any] = [:]
      var failure: Error?
      autoreleasepool {
        do {
          result = try FamiliarVision.analyze(fileUri: fileUri, options: options)
        } catch {
          failure = error
        }
      }
      if let failure { throw failure }
      return result
    }
  }
}

enum FamiliarVision {
  /// Big enough for faces in a recorder snapshot, small enough to stay light in the background.
  static let maxSide = 1280
  /// Faces turned further than this (radians) are skipped rather than guessed at.
  static let maxYaw = 0.6
  static let maxRoll = 0.45
  static let minQuality: Float = 0.2

  static func analyze(fileUri: String, options: AnalyzeOptionsRecord) throws -> [String: Any] {
    guard let image = loadImage(fileUri, maxSide: maxSide) else {
      throw Exception(name: "SightlineVision", description: "Couldn't read that picture")
    }
    let cropDir = options.cropDir.flatMap { prepareDir($0) }
    var faces: [[String: Any]] = []
    var vehicles: [[String: Any]] = []
    var skipped = 0

    if options.faces {
      let found = try detectFaces(image, options: options, cropDir: cropDir)
      faces = found.faces
      skipped = found.skipped
    }
    if options.vehicles, let v = try vehicle(image, plates: options.plates, cropDir: cropDir) {
      vehicles.append(v)
    }
    return [
      "width": image.width,
      "height": image.height,
      "faces": faces,
      "vehicles": vehicles,
      "skippedFaces": skipped,
    ]
  }

  // MARK: Faces

  static func detectFaces(_ image: CGImage, options: AnalyzeOptionsRecord, cropDir: URL?) throws -> (faces: [[String: Any]], skipped: Int) {
    let rects = VNDetectFaceRectanglesRequest()
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([rects])
    let observations: [VNFaceObservation] = rects.results ?? []
    if observations.isEmpty { return ([], 0) }

    // Capture quality (blur, lighting, pose) for the same faces.
    let quality = VNDetectFaceCaptureQualityRequest()
    quality.inputFaceObservations = observations
    try? handler.perform([quality])
    let rated: [VNFaceObservation] = quality.results ?? []

    var out: [[String: Any]] = []
    var skipped = 0
    let w = CGFloat(image.width)
    let h = CGFloat(image.height)
    let limit = max(1, min(options.maxFaces, 8))
    // Largest faces first: they're the ones with enough detail.
    let sorted = observations.sorted { $0.boundingBox.width * $0.boundingBox.height > $1.boundingBox.width * $1.boundingBox.height }
    for (index, face) in sorted.enumerated() {
      if out.count >= limit { skipped += sorted.count - index; break }
      let box = face.boundingBox
      let side = min(box.width * w, box.height * h)
      let yaw = abs(face.yaw?.doubleValue ?? 0)
      let roll = abs(face.roll?.doubleValue ?? 0)
      let q = rated.first(where: { $0.uuid == face.uuid })?.faceCaptureQuality
        ?? rated.first(where: { $0.boundingBox.equalTo(face.boundingBox) })?.faceCaptureQuality
      if Double(side) < options.minFacePx || yaw > maxYaw || roll > maxRoll || (q != nil && q! < minQuality) {
        skipped += 1
        continue
      }
      let rect = pixelRect(box, width: w, height: h, grow: 1.3, square: true)
      guard rect.width >= 16, rect.height >= 16, let crop = image.cropping(to: rect),
            let print = try featurePrint(crop) else {
        skipped += 1
        continue
      }
      var item: [String: Any] = [
        "box": boxDict(box),
        "quality": Double(q ?? 0.5),
        "print": encode(print),
        "dim": print.count,
      ]
      if let cropDir, let file = writeCrop(crop, dir: cropDir) { item["crop"] = file }
      out.append(item)
    }
    return (out, skipped)
  }

  // MARK: Vehicles

  /// The most salient object (usually the vehicle in an event snapshot), its print and plate text.
  static func vehicle(_ image: CGImage, plates: Bool, cropDir: URL?) throws -> [String: Any]? {
    let saliency = VNGenerateObjectnessBasedSaliencyImageRequest()
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try? handler.perform([saliency])
    let objects: [VNRectangleObservation] = saliency.results?.first?.salientObjects ?? []
    let best = objects.max { a, b in
      Double(a.boundingBox.width * a.boundingBox.height) * Double(a.confidence) <
        Double(b.boundingBox.width * b.boundingBox.height) * Double(b.confidence)
    }
    var box = best?.boundingBox ?? CGRect(x: 0, y: 0, width: 1, height: 1)
    if box.width * box.height < 0.01 { box = CGRect(x: 0, y: 0, width: 1, height: 1) }
    let w = CGFloat(image.width)
    let h = CGFloat(image.height)
    let rect = pixelRect(box, width: w, height: h, grow: 1.1, square: false)
    guard rect.width >= 32, rect.height >= 32, let crop = image.cropping(to: rect), let print = try featurePrint(crop) else {
      return nil
    }
    var item: [String: Any] = [
      "box": boxDict(box),
      "quality": Double(best?.confidence ?? 0),
      "print": encode(print),
      "dim": print.count,
    ]
    if plates { item["texts"] = recognizeText(crop) }
    if let cropDir, let file = writeCrop(crop, dir: cropDir) { item["crop"] = file }
    return item
  }

  static func recognizeText(_ image: CGImage) -> [String] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.minimumTextHeight = 0.04
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    guard (try? handler.perform([request])) != nil else { return [] }
    let results: [VNRecognizedTextObservation] = request.results ?? []
    return results.prefix(12).compactMap { $0.topCandidates(1).first?.string }
  }

  // MARK: Feature prints

  static func featurePrint(_ image: CGImage) throws -> [Float]? {
    let request = VNGenerateImageFeaturePrintRequest()
    request.imageCropAndScaleOption = .scaleFill
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])
    guard let observation = request.results?.first else { return nil }
    return floats(observation)
  }

  /// The print as unit-length Float32 values, whatever element type this OS revision uses.
  static func floats(_ observation: VNFeaturePrintObservation) -> [Float]? {
    let count = observation.elementCount
    let data = observation.data
    guard count > 0 else { return nil }
    var values = [Float](repeating: 0, count: count)
    switch observation.elementType {
    case .float:
      guard data.count >= count * 4 else { return nil }
      data.withUnsafeBytes { raw in
        for i in 0..<count { values[i] = raw.loadUnaligned(fromByteOffset: i * 4, as: Float.self) }
      }
    case .double:
      guard data.count >= count * 8 else { return nil }
      data.withUnsafeBytes { raw in
        for i in 0..<count { values[i] = Float(raw.loadUnaligned(fromByteOffset: i * 8, as: Double.self)) }
      }
    default:
      return nil
    }
    var norm: Float = 0
    for v in values { norm += v * v }
    norm = norm.squareRoot()
    guard norm > 0, norm.isFinite else { return nil }
    return values.map { $0 / norm }
  }

  static func encode(_ values: [Float]) -> String {
    values.withUnsafeBufferPointer { Data(buffer: $0) }.base64EncodedString()
  }

  // MARK: Helpers

  static func loadImage(_ uri: String, maxSide: Int) -> CGImage? {
    let url: URL
    if uri.hasPrefix("file://"), let u = URL(string: uri) {
      url = u
    } else {
      url = URL(fileURLWithPath: uri)
    }
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxSide,
      kCGImageSourceShouldCacheImmediately: true,
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, opts as CFDictionary)
  }

  /// Vision boxes are normalized with a bottom-left origin; CGImage cropping is top-left pixels.
  static func pixelRect(_ box: CGRect, width: CGFloat, height: CGFloat, grow: CGFloat, square: Bool) -> CGRect {
    var r = CGRect(x: box.minX * width, y: (1 - box.maxY) * height, width: box.width * width, height: box.height * height)
    if square {
      let side = max(r.width, r.height) * grow
      r = CGRect(x: r.midX - side / 2, y: r.midY - side / 2, width: side, height: side)
    } else {
      r = r.insetBy(dx: -r.width * (grow - 1) / 2, dy: -r.height * (grow - 1) / 2)
    }
    return r.intersection(CGRect(x: 0, y: 0, width: width, height: height)).integral
  }

  /// Top-left-origin normalized box for JS.
  static func boxDict(_ box: CGRect) -> [String: Double] {
    ["x": Double(box.minX), "y": Double(1 - box.maxY), "w": Double(box.width), "h": Double(box.height)]
  }

  static func prepareDir(_ uri: String) -> URL? {
    let url: URL
    if uri.hasPrefix("file://"), let u = URL(string: uri) {
      url = u
    } else {
      url = URL(fileURLWithPath: uri)
    }
    do {
      try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
      return url
    } catch {
      return nil
    }
  }

  /// A small JPEG for the "Who is this?" card (at most 160 px).
  static func writeCrop(_ image: CGImage, dir: URL) -> String? {
    let maxSide: CGFloat = 160
    let scale = min(1, maxSide / CGFloat(max(image.width, image.height)))
    let size = CGSize(width: max(1, CGFloat(image.width) * scale), height: max(1, CGFloat(image.height) * scale))
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let rendered = UIGraphicsImageRenderer(size: size, format: format).image { _ in
      UIImage(cgImage: image).draw(in: CGRect(origin: .zero, size: size))
    }
    guard let jpeg = rendered.jpegData(compressionQuality: 0.8) else { return nil }
    let file = dir.appendingPathComponent("\(UUID().uuidString).jpg")
    do {
      try jpeg.write(to: file, options: .atomic)
      return file.absoluteString
    } catch {
      return nil
    }
  }
}
