import ActivityKit
import SwiftUI
import WidgetKit

// MARK: - Lock Screen / Dynamic Island: doorbell rings and ongoing camera events

/// Must match modules/live-activity/ios/LiveActivityModule.swift exactly (same type name and
/// fields): ActivityKit pairs the app's activity with this layout by this type.
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
  var key: String
  var camera: String
  /// sightline:// link opened by a tap or the Watch button.
  var url: String
}

/// app/src/theme/tokens.ts (dark palette, violet accent).
private enum Brand {
  static let accent = Color(red: 124 / 255, green: 92 / 255, blue: 255 / 255)
  static let background = Color(red: 11 / 255, green: 13 / 255, blue: 18 / 255)
  static let surface = Color(red: 27 / 255, green: 31 / 255, blue: 40 / 255)
  static let text = Color(red: 242 / 255, green: 244 / 255, blue: 247 / 255)
  static let muted = Color(red: 154 / 255, green: 161 / 255, blue: 173 / 255)
}

private extension ActivityViewContext where Attributes == SightlineActivityAttributes {
  var isDoorbell: Bool { attributes.kind == "doorbell" }
  var isOver: Bool { state.ended || isStale }
  var symbol: String { isDoorbell ? "bell.fill" : "video.fill" }
  var link: URL { URL(string: attributes.url) ?? URL(string: "sightline://")! }
  var start: Date { Date(timeIntervalSince1970: state.since) }
}

private struct Thumbnail: View {
  let path: String?
  let symbol: String
  let width: CGFloat
  let height: CGFloat

  var body: some View {
    ZStack {
      if let image = Shared.image(path) {
        Image(uiImage: image).resizable().scaledToFill()
      } else {
        Brand.surface
        Image(systemName: symbol).font(.system(size: height * 0.35)).foregroundStyle(Brand.accent)
      }
    }
    .frame(width: width, height: height)
    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
  }
}

/// "0:42" counting up from the start, or "Ended".
private struct Elapsed: View {
  let start: Date
  let over: Bool

  var body: some View {
    if over {
      Text("Ended")
    } else {
      Text(start, style: .timer).monospacedDigit()
    }
  }
}

private struct WatchButton: View {
  let url: URL
  let label: String

  var body: some View {
    Link(destination: url) {
      Label(label, systemImage: "play.fill")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(.white)
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .background(Capsule().fill(Brand.accent))
    }
  }
}

private struct LockScreenView: View {
  let context: ActivityViewContext<SightlineActivityAttributes>

  var body: some View {
    HStack(spacing: 12) {
      Thumbnail(path: context.state.image, symbol: context.symbol, width: 96, height: 64)
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 4) {
          Image(systemName: context.symbol)
          Text(context.isDoorbell ? "Doorbell" : "Camera")
          Spacer(minLength: 4)
          Elapsed(start: context.start, over: context.isOver).foregroundStyle(Brand.muted)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(Brand.accent)
        Text(context.state.headline).font(.headline).foregroundStyle(Brand.text).lineLimit(1)
        Text(context.attributes.camera).font(.subheadline).foregroundStyle(Brand.muted).lineLimit(1)
      }
      if context.isDoorbell && !context.isOver {
        WatchButton(url: context.link, label: "Watch")
      }
    }
    .padding(14)
  }
}

struct SightlineLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: SightlineActivityAttributes.self) { context in
      LockScreenView(context: context)
        .widgetURL(context.link)
        .activityBackgroundTint(Brand.background.opacity(0.92))
        .activitySystemActionForegroundColor(Brand.text)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Thumbnail(path: context.state.image, symbol: context.symbol, width: 72, height: 48)
            .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Elapsed(start: context.start, over: context.isOver)
            .font(.caption.weight(.semibold))
            .foregroundStyle(Brand.muted)
            .frame(maxWidth: 64, alignment: .trailing)
            .padding(.trailing, 4)
        }
        DynamicIslandExpandedRegion(.center) {
          VStack(alignment: .leading, spacing: 1) {
            Text(context.state.headline).font(.headline).foregroundStyle(Brand.text).lineLimit(1)
            Text(context.attributes.camera).font(.caption).foregroundStyle(Brand.muted).lineLimit(1)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        DynamicIslandExpandedRegion(.bottom) {
          if !context.isOver {
            WatchButton(url: context.link, label: context.isDoorbell ? "Watch" : "Watch live")
              .padding(.top, 4)
          }
        }
      } compactLeading: {
        Image(systemName: context.symbol).foregroundStyle(Brand.accent)
      } compactTrailing: {
        Elapsed(start: context.start, over: context.isOver)
          .font(.caption2.weight(.semibold))
          .foregroundStyle(Brand.text)
          .frame(maxWidth: 44)
      } minimal: {
        Image(systemName: context.symbol).foregroundStyle(Brand.accent)
      }
      .widgetURL(context.link)
      .keylineTint(Brand.accent)
    }
  }
}
