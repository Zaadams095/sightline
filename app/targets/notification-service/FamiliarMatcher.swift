import CoreGraphics
import Foundation
import ImageIO
import Vision
import os

/// Familiar faces for Instant Alerts: the Hub can't run Apple Vision, so this extension looks
/// at the picture it just attached and, when it clearly recognizes someone the user named in
/// People & vehicles, rewrites the title ("Dad is at Front Door").
///
/// The gallery (named people's feature prints, plates) is written by the app into the App
/// Group container at familiar/gallery.json (src/familiar/gallery.ts). Same rules as
/// src/familiar/match.ts (bestMatch / normalizePlate); keep them in step. Everything stays on
/// the phone. Notification service extensions get ~24 MB, so this checks the memory that's
/// left first and quietly does nothing when it's tight, or on any error.
enum FamiliarMatcher {
  struct Gallery: Decodable {
    struct Person: Decodable {
      let name: String
      let prints: [String]
    }
    struct Plate: Decodable {
      let name: String
      let plates: [String]
    }
    let v: Int
    let enabled: Bool
    let threshold: Double
    let margin: Double
    let minVotes: Int
    let faces: [Person]
    let plates: [Plate]
  }

  /// Below this much free memory, skip recognition (the attachment matters more).
  static let minFreeBytes = 12 * 1024 * 1024

  static func loadGallery() -> Gallery? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "SightlineAppGroup") as? String,
          let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
          let data = try? Data(contentsOf: base.appendingPathComponent("familiar/gallery.json")),
          let gallery = try? JSONDecoder().decode(Gallery.self, from: data),
          gallery.v == 1, gallery.enabled else { return nil }
    return gallery
  }

  /// "Dad" (or "Dad & Our car") when someone is clearly recognized, else nil.
  static func recognize(imageData: Data) -> String? {
    guard let gallery = loadGallery(), !gallery.faces.isEmpty || !gallery.plates.isEmpty else { return nil }
    guard os_proc_available_memory() > minFreeBytes else { return nil }
    var names: [String] = []
    autoreleasepool {
      guard let image = loadImage(imageData, maxSide: 960) else { return }
      if !gallery.faces.isEmpty { names.append(contentsOf: faces(image, gallery: gallery)) }
      if !gallery.plates.isEmpty, os_proc_available_memory() > minFreeBytes {
        names.append(contentsOf: plates(image, gallery: gallery))
      }
    }
    var seen = Set<String>()
    let unique = names.filter { seen.insert($0).inserted }
    return unique.isEmpty ? nil : unique.prefix(2).joined(separator: " & ")
  }

  /// "Person · Front Door" → "Dad is at Front Door"; other titles get the name in front.
  static func title(_ original: String, name: String) -> String {
    if let range = original.range(of: " · ", options: .backwards) {
      let camera = String(original[range.upperBound...])
      if !camera.isEmpty { return String(localized: "\(name) is at \(camera)") }
    }
    return original.isEmpty ? name : "\(name) · \(original)"
  }

  // MARK: Faces

  static func faces(_ image: CGImage, gallery: Gallery) -> [String] {
    let people: [(name: String, prints: [[Float]])] = gallery.faces.map { p in
      (name: p.name, prints: p.prints.compactMap { FamiliarMatcher.decode($0) })
    }
    let request = VNDetectFaceRectanglesRequest()
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    guard (try? handler.perform([request])) != nil else { return [] }
    let observations: [VNFaceObservation] = request.results ?? []
    let w = CGFloat(image.width)
    let h = CGFloat(image.height)
    var found: [String] = []
    for face in observations.prefix(3) {
      let box = face.boundingBox
      if min(box.width * w, box.height * h) < 40 { continue }
      if abs(face.yaw?.doubleValue ?? 0) > 0.6 || abs(face.roll?.doubleValue ?? 0) > 0.45 { continue }
      var r = CGRect(x: box.minX * w, y: (1 - box.maxY) * h, width: box.width * w, height: box.height * h)
      let side = max(r.width, r.height) * 1.3
      r = CGRect(x: r.midX - side / 2, y: r.midY - side / 2, width: side, height: side)
        .intersection(CGRect(x: 0, y: 0, width: w, height: h)).integral
      guard let crop = image.cropping(to: r), let print = featurePrint(crop) else { continue }
      if let name = bestMatch(print, people: people, gallery: gallery) { found.append(name) }
      if os_proc_available_memory() < minFreeBytes { break }
    }
    return found
  }

  static func bestMatch(_ print: [Float], people: [(name: String, prints: [[Float]])], gallery: Gallery) -> String? {
    var scored: [(name: String, score: Double, ok: Bool)] = []
    for person in people {
      let sims = person.prints.map { FamiliarMatcher.cosine(print, $0) }.sorted(by: >)
      let need = max(1, min(gallery.minVotes, sims.count))
      let top = sims.prefix(need)
      let score = top.isEmpty ? -1 : top.reduce(0, +) / Double(top.count)
      let votes = sims.filter { $0 >= gallery.threshold }.count
      scored.append((person.name, score, votes >= need && score >= gallery.threshold))
    }
    scored.sort { $0.score > $1.score }
    guard let best = scored.first, best.ok else { return nil }
    if scored.count > 1, best.score - scored[1].score < gallery.margin { return nil }
    return best.name
  }

  static func cosine(_ a: [Float], _ b: [Float]) -> Double {
    guard a.count == b.count, !a.isEmpty else { return -1 }
    var dot: Double = 0
    var na: Double = 0
    var nb: Double = 0
    for i in 0..<a.count {
      dot += Double(a[i]) * Double(b[i])
      na += Double(a[i]) * Double(a[i])
      nb += Double(b[i]) * Double(b[i])
    }
    guard na > 0, nb > 0 else { return -1 }
    return dot / (na.squareRoot() * nb.squareRoot())
  }

  static func featurePrint(_ image: CGImage) -> [Float]? {
    let request = VNGenerateImageFeaturePrintRequest()
    request.imageCropAndScaleOption = .scaleFill
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    guard (try? handler.perform([request])) != nil, let observation = request.results?.first else { return nil }
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
    return values
  }

  static func decode(_ b64: String) -> [Float]? {
    guard let data = Data(base64Encoded: b64), data.count >= 4 else { return nil }
    let count = data.count / 4
    var values = [Float](repeating: 0, count: count)
    data.withUnsafeBytes { raw in
      for i in 0..<count { values[i] = raw.loadUnaligned(fromByteOffset: i * 4, as: Float.self) }
    }
    return values
  }

  // MARK: Plates

  static func plates(_ image: CGImage, gallery: Gallery) -> [String] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    guard (try? handler.perform([request])) != nil else { return [] }
    let observations: [VNRecognizedTextObservation] = request.results ?? []
    var read: [String] = []
    for observation in observations.prefix(20) {
      if let text = observation.topCandidates(1).first?.string, let plate = normalizePlate(text) { read.append(plate) }
    }
    var found: [String] = []
    for entry in gallery.plates {
      var hit = false
      for known in entry.plates {
        for plate in read where platesMatch(plate, known) { hit = true }
      }
      if hit { found.append(entry.name) }
    }
    return found
  }

  static func normalizePlate(_ text: String) -> String? {
    var t = ""
    for scalar in text.uppercased().unicodeScalars where scalar.isASCII && CharacterSet.alphanumerics.contains(scalar) {
      t.unicodeScalars.append(scalar)
    }
    guard t.count >= 4, t.count <= 8, t.contains(where: { $0.isNumber }) else { return nil }
    if t.count == 4, t.allSatisfy({ $0.isNumber }) { return nil }
    return t
  }

  static func platesMatch(_ a: String, _ b: String) -> Bool {
    if a == b { return true }
    guard a.count == b.count, a.count >= 6 else { return false }
    return zip(a, b).filter { $0 != $1 }.count <= 1
  }

  static func loadImage(_ data: Data, maxSide: Int) -> CGImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxSide,
      kCGImageSourceShouldCacheImmediately: true,
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, opts as CFDictionary)
  }
}
