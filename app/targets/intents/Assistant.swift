import Foundation
import SwiftUI
import UIKit

// Answers for Siri / HomePod ("Who's at the door?", "Any packages today?", "What happened on
// the backyard?"). The extension can't reach the cameras (no VPN, no passwords), so it answers
// from the summary the app leaves in the App Group (app/src/ask/sync.ts, format in
// app/src/ask/assistant-data.ts). Answers say how old that summary is when it isn't fresh.

struct AssistantEvent: Codable {
  let id: String
  let key: String
  let camera: String
  let time: Double
  let end: Double?
  let objects: [String]
  let names: [String]
  let package: Bool
  let doorbell: Bool
  let image: String?
}

struct AssistantPackage: Codable {
  let key: String
  let camera: String
  let since: Double
  let image: String?
}

struct AssistantCamera: Codable {
  let key: String
  let name: String
  let door: Bool
}

struct AssistantData: Codable {
  let updatedAt: Double
  let cameras: [AssistantCamera]
  let events: [AssistantEvent]
  let packages: [AssistantPackage]
}

/// What Siri says, and what the snippet shows.
struct AssistantReply {
  let text: String
  /// App Group path of a picture to show (iPhone / iPad / Mac only; HomePod just speaks).
  let image: String?
  let caption: String?
}

enum Assistant {
  /// Someone "at the door" means seen in the last few minutes.
  static let doorFreshSeconds: Double = 10 * 60
  /// After this, answers mention when Sightline last checked.
  static let staleSeconds: Double = 20 * 60

  static func load() -> AssistantData? {
    guard let base = Shared.container,
          let data = try? Data(contentsOf: base.appendingPathComponent("siri/events.json")) else { return nil }
    return try? JSONDecoder().decode(AssistantData.self, from: data)
  }

  static var noData: AssistantReply { AssistantReply(
    text: String(localized: "I don't have anything from your cameras yet. Open Sightline once, then ask again."),
    image: nil,
    caption: nil
  ) }

  // MARK: Words

  static func clock(_ t: Double) -> String {
    let f = DateFormatter()
    f.timeStyle = .short
    f.dateStyle = .none
    return f.string(from: Date(timeIntervalSince1970: t))
  }

  /// "just now", "4 minutes ago", "at 2:14 PM", "yesterday at 9:10 PM", "on Tuesday at 7:05 AM".
  static func when(_ t: Double, now: Date = Date()) -> String {
    let date = Date(timeIntervalSince1970: t)
    let minutes = Int(now.timeIntervalSince(date) / 60)
    if minutes < 1 { return String(localized: "just now") }
    if minutes < 60 { return minutes == 1 ? String(localized: "a minute ago") : String(localized: "\(minutes) minutes ago") }
    let cal = Calendar.current
    let time = clock(t)
    if cal.isDateInToday(date) { return String(localized: "at \(time)") }
    if cal.isDateInYesterday(date) { return String(localized: "yesterday at \(time)") }
    let f = DateFormatter()
    f.setLocalizedDateFormatFromTemplate("EEEE")
    let day = f.string(from: date)
    return String(localized: "on \(day) at \(time)")
  }

  static func list(_ items: [String]) -> String {
    if items.count <= 1 { return items.first ?? "" }
    let head = items.dropLast().joined(separator: ", ")
    let last = items[items.count - 1]
    return String(localized: "\(head) and \(last)")
  }

  static let vehicles: Set<String> = ["car", "truck", "vehicle", "van", "bus", "motorcycle", "motorbike", "license_plate", "boat"]
  static let animals: Set<String> = ["animal", "dog", "cat", "bird", "deer", "bear", "horse", "fox", "raccoon", "squirrel", "rabbit", "cow", "sheep", "goat", "skunk", "opossum", "coyote", "pet"]
  static let carriers: Set<String> = ["amazon", "ups", "fedex", "usps", "dhl", "dpd", "gls", "an_post", "purolator", "postnl", "nzpost", "postnord", "royal_mail"]

  static func people(_ e: AssistantEvent) -> [String] {
    e.names.filter { !carriers.contains($0.lowercased()) }
  }

  /// "Emma", "someone", "a package", "a car"…
  static func subject(_ e: AssistantEvent) -> String {
    let names = people(e)
    if !names.isEmpty { return list(names) }
    if e.doorbell { return String(localized: "someone ringing the doorbell") }
    if e.package { return String(localized: "a package") }
    if e.objects.contains("person") || e.objects.contains("face") { return String(localized: "someone") }
    if let v = e.objects.first(where: { vehicles.contains($0) }) { return v == "truck" ? String(localized: "a truck") : String(localized: "a car") }
    if let a = e.objects.first(where: { animals.contains($0) }) { return animal(a) }
    if let o = e.objects.first { return thing(o) }
    return String(localized: "motion")
  }

  /// "a dog", "an animal"… in the phone's language.
  static func animal(_ a: String) -> String {
    switch a {
    case "dog": return String(localized: "a dog")
    case "cat": return String(localized: "a cat")
    case "bird": return String(localized: "a bird")
    case "deer": return String(localized: "a deer")
    case "bear": return String(localized: "a bear")
    case "horse": return String(localized: "a horse")
    case "fox": return String(localized: "a fox")
    case "raccoon": return String(localized: "a raccoon")
    case "squirrel": return String(localized: "a squirrel")
    case "rabbit": return String(localized: "a rabbit")
    case "cow": return String(localized: "a cow")
    case "sheep": return String(localized: "a sheep")
    case "goat": return String(localized: "a goat")
    case "skunk": return String(localized: "a skunk")
    case "opossum": return String(localized: "an opossum")
    case "coyote": return String(localized: "a coyote")
    case "pet": return String(localized: "a pet")
    default: return String(localized: "an animal")
    }
  }

  /// Any other detected object: "a bicycle", else the raw label ("a umbrella").
  static func thing(_ o: String) -> String {
    switch o {
    case "bicycle": return String(localized: "a bicycle")
    case "license_plate": return String(localized: "a license plate")
    default:
      let label = o.replacingOccurrences(of: "_", with: " ")
      return String(localized: "a \(label)")
    }
  }

  static func freshness(_ data: AssistantData, now: Date = Date()) -> String {
    let age = now.timeIntervalSince1970 - data.updatedAt
    let checked = when(data.updatedAt, now: now)
    return age > staleSeconds ? " " + String(localized: "Sightline last checked your cameras \(checked).") : ""
  }

  /// A picture for an event: its own, else the camera's latest widget snapshot.
  static func picture(for key: String, event: AssistantEvent?) -> String? {
    if let image = event?.image { return image }
    return Shared.cameras().first(where: { $0.key == key })?.image
  }

  static func capitalized(_ s: String) -> String {
    s.prefix(1).uppercased() + s.dropFirst()
  }

  // MARK: Answers

  static func whoIsAtTheDoor(now: Date = Date()) -> AssistantReply {
    guard let data = load() else { return noData }
    let doorKeys = Set(data.cameras.filter { $0.door }.map { $0.key })
    let atDoor = data.events.filter { e in
      (doorKeys.isEmpty || doorKeys.contains(e.key) || e.doorbell)
        && (e.doorbell || !people(e).isEmpty || e.objects.contains("person") || e.objects.contains("face"))
    }
    let stale = freshness(data, now: now)
    guard let latest = atDoor.first else {
      let key = doorKeys.first ?? data.cameras.first?.key
      let nobody = doorKeys.isEmpty
        ? String(localized: "I haven't seen anyone in the last two days.")
        : String(localized: "I haven't seen anyone at the door in the last two days.")
      return AssistantReply(
        text: nobody + stale,
        image: key.flatMap { picture(for: $0, event: nil) },
        caption: nil
      )
    }
    let age = now.timeIntervalSince1970 - latest.time
    let ongoing = latest.end == nil
    let who = subject(latest)
    let camera = latest.camera
    let at = when(latest.time, now: now)
    let text: String
    if age < doorFreshSeconds || ongoing {
      let whoCap = capitalized(who)
      if latest.doorbell && people(latest).isEmpty {
        text = String(localized: "Someone rang the doorbell at \(camera) \(at).")
      } else if ongoing {
        text = String(localized: "\(whoCap) is at \(camera) \(at).")
      } else {
        text = String(localized: "\(whoCap) was at \(camera) \(at).")
      }
    } else {
      text = String(localized: "Nobody right now, as far as I can tell. The last one was \(who) at \(camera) \(at).")
    }
    return AssistantReply(
      text: text + stale,
      image: picture(for: latest.key, event: latest),
      caption: "\(latest.camera) · \(clock(latest.time))"
    )
  }

  static func packagesToday(now: Date = Date()) -> AssistantReply {
    guard let data = load() else { return noData }
    let stale = freshness(data, now: now)
    let startOfDay = Calendar.current.startOfDay(for: now).timeIntervalSince1970
    if !data.packages.isEmpty {
      let parts = data.packages.map { "\($0.camera) \(when($0.since, now: now))" }
      let count = data.packages.count
      let first = parts[0]
      let all = list(parts)
      let text = count == 1
        ? String(localized: "Yes. A package was delivered to \(first), and it looks like it's still there.")
        : String(localized: "Yes, \(count) packages look like they're still outside: \(all).")
      let pkg = data.packages[0]
      return AssistantReply(
        text: text + stale,
        image: pkg.image ?? picture(for: pkg.key, event: nil),
        caption: "\(pkg.camera) · \(clock(pkg.since))"
      )
    }
    let today = data.events.filter { $0.time >= startOfDay && ($0.package || $0.objects.contains { carriers.contains($0) } || $0.names.contains { carriers.contains($0.lowercased()) }) }
    guard let latest = today.first else {
      return AssistantReply(text: String(localized: "No packages today, as far as Sightline has seen.") + stale, image: nil, caption: nil)
    }
    let camera = latest.camera
    let at = when(latest.time, now: now)
    let text = latest.package
      ? String(localized: "Yes. A package was seen at \(camera) \(at). It may have been picked up since.")
      : String(localized: "A delivery came to \(camera) \(at).")
    return AssistantReply(text: text + stale, image: picture(for: latest.key, event: latest), caption: "\(latest.camera) · \(clock(latest.time))")
  }

  static func whatHappened(cameraKey: String?, cameraName: String?, now: Date = Date()) -> AssistantReply {
    guard let data = load() else { return noData }
    let stale = freshness(data, now: now)
    let startOfDay = Calendar.current.startOfDay(for: now).timeIntervalSince1970
    let events = data.events.filter { $0.time >= startOfDay && (cameraKey == nil || $0.key == cameraKey) }
    guard let latest = events.first else {
      let nothing: String
      if let name = cameraName {
        nothing = String(localized: "Nothing happened on \(name) today, as far as Sightline has seen.")
      } else {
        nothing = String(localized: "Nothing happened today, as far as Sightline has seen.")
      }
      return AssistantReply(
        text: nothing + stale,
        image: cameraKey.flatMap { picture(for: $0, event: nil) },
        caption: nil
      )
    }
    var counts: [(String, Int)] = []
    func add(_ label: String, _ n: Int) { if n > 0 { counts.append((label, n)) } }
    let named = Set(events.flatMap { people($0) })
    add("person", events.filter { people($0).isEmpty && ($0.objects.contains("person") || $0.objects.contains("face")) }.count)
    add("vehicle", events.filter { $0.objects.contains { vehicles.contains($0) } }.count)
    add("animal", events.filter { $0.objects.contains { animals.contains($0) } }.count)
    add("package", events.filter { $0.package }.count)
    add("doorbell ring", events.filter { $0.doorbell }.count)
    var parts = counts.map { label, n -> String in
      switch label {
      case "person": return n == 1 ? String(localized: "someone once") : String(localized: "people \(n) times")
      case "vehicle": return n == 1 ? String(localized: "a vehicle") : String(localized: "\(n) vehicles")
      case "animal": return n == 1 ? String(localized: "an animal") : String(localized: "\(n) animals")
      case "package": return n == 1 ? String(localized: "a package") : String(localized: "\(n) packages")
      default: return n == 1 ? String(localized: "a doorbell ring") : String(localized: "\(n) doorbell rings")
      }
    }
    if !named.isEmpty { parts.insert(list(named.sorted()), at: 0) }
    let motionCount = events.count
    let summary = parts.isEmpty
      ? (motionCount == 1 ? String(localized: "some motion") : String(localized: "motion \(motionCount) times"))
      : list(parts)
    let todayText: String
    if let name = cameraName {
      todayText = String(localized: "Today on \(name): \(summary).")
    } else {
      todayText = String(localized: "Today: \(summary).")
    }
    let what = subject(latest)
    let camera = latest.camera
    let at = when(latest.time, now: now)
    let latestText = cameraKey == nil
      ? String(localized: "The latest was \(what) on \(camera) \(at).")
      : String(localized: "The latest was \(what) \(at).")
    let text = todayText + " " + latestText
    return AssistantReply(text: text + stale, image: picture(for: latest.key, event: latest), caption: "\(latest.camera) · \(clock(latest.time))")
  }
}

/// The picture Siri shows under the answer on iPhone / iPad.
struct AssistantSnippet: View {
  let reply: AssistantReply

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let ui = Shared.image(reply.image) {
        Image(uiImage: ui)
          .resizable()
          .scaledToFill()
          .frame(maxWidth: .infinity)
          .frame(height: 190)
          .clipped()
          .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
          .accessibilityLabel("Latest picture from your camera")
      }
      if let caption = reply.caption {
        Text(caption)
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
    }
    .padding()
  }
}
