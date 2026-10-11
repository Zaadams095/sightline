import AppIntents
import SwiftUI
import WidgetKit

// MARK: - Camera snapshots (Home Screen)

struct SelectCamerasIntent: WidgetConfigurationIntent {
  static let title: LocalizedStringResource = "Choose cameras"
  static let description = IntentDescription("Pick which cameras this widget shows.")

  @Parameter(title: "Cameras")
  var cameras: [CameraEntity]?
}

struct CamerasEntry: TimelineEntry {
  let date: Date
  let cameras: [SharedCamera]
}

struct CamerasProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> CamerasEntry {
    CamerasEntry(date: .now, cameras: [])
  }

  func snapshot(for configuration: SelectCamerasIntent, in context: Context) async -> CamerasEntry {
    entry(for: configuration, family: context.family)
  }

  // Images come from the app; re-read every 15 min in case it refreshed them meanwhile.
  func timeline(for configuration: SelectCamerasIntent, in context: Context) async -> Timeline<CamerasEntry> {
    Timeline(entries: [entry(for: configuration, family: context.family)], policy: .after(.now.addingTimeInterval(15 * 60)))
  }

  private func entry(for configuration: SelectCamerasIntent, family: WidgetFamily) -> CamerasEntry {
    let all = Shared.cameras()
    let chosen = (configuration.cameras ?? []).compactMap { c in all.first { $0.key == c.id } }
    let count = family == .systemSmall ? 1 : family == .systemMedium ? 2 : 4
    return CamerasEntry(date: .now, cameras: Array((chosen.isEmpty ? all : chosen).prefix(count)))
  }
}

struct CameraTileView: View {
  let camera: SharedCamera

  var body: some View {
    ZStack(alignment: .bottomLeading) {
      if let image = Shared.image(camera.image) {
        Image(uiImage: image).resizable().scaledToFill()
      } else {
        Color(white: 0.12)
        Image(systemName: "video.slash").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
      }
      LinearGradient(colors: [.clear, .black.opacity(0.65)], startPoint: .center, endPoint: .bottom)
      VStack(alignment: .leading, spacing: 1) {
        Text(camera.name).font(.caption.weight(.semibold)).lineLimit(1)
        if let t = camera.updatedAt {
          Text(Date(timeIntervalSince1970: t), style: .relative).font(.caption2).opacity(0.8)
        }
      }
      .foregroundStyle(.white)
      .padding(6)
    }
    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
  }
}

struct CamerasWidgetView: View {
  let entry: CamerasEntry
  @Environment(\.widgetFamily) private var family

  var body: some View {
    Group {
      if entry.cameras.isEmpty {
        VStack(spacing: 6) {
          Image(systemName: "video").font(.title2)
          Text("Open Sightline to load your cameras").font(.caption).multilineTextAlignment(.center)
        }
        .foregroundStyle(.secondary)
      } else if family == .systemSmall {
        CameraTileView(camera: entry.cameras[0]).widgetURL(Shared.cameraURL(entry.cameras[0].key))
      } else {
        let columns = Array(repeating: GridItem(.flexible(), spacing: 6), count: 2)
        LazyVGrid(columns: columns, spacing: 6) {
          ForEach(entry.cameras, id: \.key) { camera in
            Link(destination: Shared.cameraURL(camera.key)) {
              CameraTileView(camera: camera).aspectRatio(family == .systemMedium ? 1.15 : 1.4, contentMode: .fit)
            }
          }
        }
      }
    }
    .containerBackground(for: .widget) { Color.black }
  }
}

struct CamerasWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: "SightlineCameras", intent: SelectCamerasIntent.self, provider: CamerasProvider()) { entry in
      CamerasWidgetView(entry: entry)
    }
    .configurationDisplayName("Cameras")
    .description("Recent snapshots from your cameras. Tap one to watch live.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    .contentMarginsDisabled()
  }
}

// MARK: - Last alert (Lock Screen)

struct AlertEntry: TimelineEntry {
  let date: Date
  let alert: LastAlert?
}

struct AlertProvider: TimelineProvider {
  func placeholder(in context: Context) -> AlertEntry {
    AlertEntry(date: .now, alert: LastAlert(title: "Person", camera: "Front Door", key: "", time: Date.now.timeIntervalSince1970))
  }

  func getSnapshot(in context: Context, completion: @escaping (AlertEntry) -> Void) {
    completion(AlertEntry(date: .now, alert: Shared.lastAlert()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<AlertEntry>) -> Void) {
    completion(Timeline(entries: [AlertEntry(date: .now, alert: Shared.lastAlert())], policy: .after(.now.addingTimeInterval(15 * 60))))
  }
}

struct LastAlertView: View {
  let entry: AlertEntry
  @Environment(\.widgetFamily) private var family

  var body: some View {
    Group {
      if let alert = entry.alert {
        switch family {
        case .accessoryInline:
          Text("\(alert.title) · \(alert.camera)")
        default:
          VStack(alignment: .leading, spacing: 1) {
            Label(alert.title, systemImage: "bell.fill").font(.headline).lineLimit(1)
            Text(alert.camera).font(.caption).lineLimit(1)
            Text(Date(timeIntervalSince1970: alert.time), style: .relative).font(.caption2)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      } else {
        Label("No alerts yet", systemImage: "bell")
      }
    }
    .widgetURL(URL(string: "sightline://review"))
    .containerBackground(for: .widget) { Color.clear }
  }
}

struct LastAlertWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "SightlineLastAlert", provider: AlertProvider()) { entry in
      LastAlertView(entry: entry)
    }
    .configurationDisplayName("Last alert")
    .description("The most recent camera alert.")
    .supportedFamilies([.accessoryRectangular, .accessoryInline])
  }
}

@main
struct SightlineWidgets: WidgetBundle {
  var body: some Widget {
    CamerasWidget()
    LastAlertWidget()
    SightlineLiveActivity()
  }
}
