import SwiftUI
import UIKit

/// Sightline violet (app/src/theme/tokens.ts ACCENTS.violet).
let accent = Color(red: 124.0 / 255.0, green: 92.0 / 255.0, blue: 1.0)

struct RootView: View {
  @EnvironmentObject var store: WatchStore

  var body: some View {
    NavigationStack {
      List {
        if let ring = store.context?.ring, Date().timeIntervalSince(ring.date) < WatchStore.ringFreshSeconds {
          Button {
            store.presentedRing = ring
          } label: {
            Label("Someone’s at the door", systemImage: "bell.fill")
              .font(.headline)
              .foregroundStyle(.white)
          }
          .listRowBackground(RoundedRectangle(cornerRadius: 12).fill(accent))
        }

        if store.cameras.isEmpty {
          EmptyState()
        } else {
          Section {
            ForEach(store.cameras, id: \.key) { camera in
              NavigationLink(value: camera.key) {
                CameraRow(camera: camera)
              }
              .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            }
          }
        }

        if !store.alerts.isEmpty {
          Section("Recent alerts") {
            ForEach(store.alerts.prefix(5)) { alert in
              NavigationLink(value: alert.key) {
                AlertRow(alert: alert)
              }
            }
            if store.alerts.count > 5 {
              NavigationLink("All alerts") { AlertsView() }
            }
          }
        }
      }
      .navigationTitle("Sightline")
      .navigationDestination(for: String.self) { key in
        CameraDetailView(key: key)
      }
    }
    .tint(accent)
    .onAppear { store.refresh() }
    .fullScreenCover(item: $store.presentedRing) { ring in
      DoorbellView(ring: ring)
        .environmentObject(store)
    }
  }
}

struct EmptyState: View {
  var body: some View {
    VStack(spacing: 8) {
      Image(systemName: "iphone")
        .font(.title2)
        .foregroundStyle(accent)
      Text("Open Sightline on your iPhone to show your cameras here.")
        .font(.body)
        .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 12)
  }
}

struct SnapshotView: View {
  @EnvironmentObject var store: WatchStore
  let key: String
  var cornerRadius: CGFloat = 12

  var body: some View {
    ZStack {
      Color(white: 0.12)
      if let snap = store.snapshots[key] {
        Image(uiImage: snap.image)
          .resizable()
          .scaledToFill()
      } else {
        ProgressView()
      }
    }
    .aspectRatio(16 / 9, contentMode: .fit)
    .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
  }
}

struct CameraRow: View {
  @EnvironmentObject var store: WatchStore
  let camera: WCamera

  var body: some View {
    ZStack(alignment: .bottomLeading) {
      SnapshotView(key: camera.key)
      LinearGradient(colors: [.clear, .black.opacity(0.7)], startPoint: .center, endPoint: .bottom)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
      Text(camera.name)
        .font(.headline)
        .foregroundStyle(.white)
        .lineLimit(1)
        .padding(8)
    }
    .task {
      // List thumbnails: fetch once, then only when older than a minute.
      if let snap = store.snapshots[camera.key], Date().timeIntervalSince(snap.at) < 60 { return }
      await store.loadSnapshot(camera.key, size: 300)
    }
  }
}

struct CameraDetailView: View {
  @EnvironmentObject var store: WatchStore
  let key: String

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 8) {
        SnapshotView(key: key, cornerRadius: 10)
        if let snap = store.snapshots[key] {
          Text("Updated \(snap.at, style: .relative) ago")
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        if !store.phoneReachable && store.camera(key)?.hub == nil {
          Text("Bring your iPhone closer to refresh this camera.")
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
      }
    }
    .navigationTitle(store.camera(key)?.name ?? "Camera")
    .task {
      // A still that refreshes every few seconds while it's on screen.
      while !Task.isCancelled {
        await store.loadSnapshot(key, size: 480)
        try? await Task.sleep(nanoseconds: 4_000_000_000)
      }
    }
  }
}

struct AlertRow: View {
  let alert: WAlert

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Label(alert.title, systemImage: alert.doorbell ? "bell.fill" : "exclamationmark.circle.fill")
        .font(.headline)
        .lineLimit(1)
      Text(alert.camera)
        .font(.footnote)
        .lineLimit(1)
      Text(alert.date, style: .relative)
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
  }
}

struct AlertsView: View {
  @EnvironmentObject var store: WatchStore

  var body: some View {
    List(store.alerts) { alert in
      NavigationLink(value: alert.key) {
        AlertRow(alert: alert)
      }
    }
    .navigationTitle("Alerts")
  }
}

struct DoorbellView: View {
  @EnvironmentObject var store: WatchStore
  let ring: WAlert

  var body: some View {
    ScrollView {
      VStack(spacing: 10) {
        Text("Someone’s at the door")
          .font(.title3.weight(.semibold))
          .multilineTextAlignment(.center)
        SnapshotView(key: ring.key, cornerRadius: 10)
        Text(ring.camera)
          .font(.headline)
        Text(ring.date, style: .time)
          .font(.footnote)
          .foregroundStyle(.secondary)
        Button("Close") { store.dismissRing() }
          .tint(accent)
      }
    }
    .task {
      while !Task.isCancelled {
        await store.loadSnapshot(ring.key, size: 480)
        try? await Task.sleep(nanoseconds: 3_000_000_000)
      }
    }
  }
}
