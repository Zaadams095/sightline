# Apple Watch and Apple TV

Sightline has two extra Apple experiences. Both work with every camera brand and need no cloud server.

| | Apple Watch | Apple TV |
|---|---|---|
| Code | `app/targets/watch` (SwiftUI), `app/modules/watch-bridge`, `app/src/watch` | `tv/` (separate Expo project on react-native-tvos), `bridge/hls_live.go` |
| Built with | The iPhone app (embedded, same EAS build) | Its own EAS build (`tv/eas.json`) |
| Data path | iPhone → WatchConnectivity; Hub public link as fallback | Sightline Hub only (own revocable token) |
| Free CI check | `.github/workflows/ios-compile.yml` (builds the watch app too) | `.github/workflows/tvos-compile.yml` (manual or on `tv/**` changes) |
| App Store | Ships inside the iPhone app | Same App Store record (universal purchase), tvOS platform |

## Apple Watch

### What it does
- **Cameras**: a scrolling list of every camera with its latest snapshot and a large name. Tap one for a bigger still that refreshes every 4 seconds while it's on screen.
- **Recent alerts**: the last 15 alerts from the past 24 hours (all systems), newest first. Tap one to open that camera.
- **Doorbell**: when a doorbell rang in the last 3 minutes, the watch opens a full-screen "Someone's at the door" view with a still that refreshes every 3 seconds. The list also has a banner for it.
- **Notifications**: alert pushes are mirrored to the watch as usual. The watch app adds a long-look for the `camera-alert` and `doorbell-ring` categories. It shows the notification's image when the watch received one; otherwise it fetches a fresh snapshot of that camera. The snooze actions still come from the iPhone's category.
- Dark, purple accent, large type.

### How the data gets there
1. **Camera list, alerts, doorbell** (`src/watch/sync.ts` → `WatchBridge.updateContext`). The phone sends a small JSON as the WatchConnectivity *application context* (`src/watch/context.ts` builds it, unit-tested in `test/watch-context.test.ts`). It sends this when the Live tab loads cameras (at most every 2 minutes), when the app comes to the foreground, after each background alert check, and right away when the phone notices a doorbell ring.
2. **Snapshots on request**. The watch calls `sendMessage {type: "snapshot", key, size}`. The phone module hands the request to JS. JS fetches the image with the camera's own adapter (`adapter.snapshot()`), so every brand works at home and over the in-app VPN. The native module downscales the image to a small JPEG (under about 60 KB) and replies. If the watch stopped waiting, the image goes over `transferFile` instead. If the request wakes the iPhone app in the background, JS lists the cameras first.
3. **Away from the phone**. For cameras on a Sightline Hub with a public link (Tailscale Funnel), the watch fetches `GET /v1/cameras/{id}/snapshot.jpg` from the Hub directly. It uses the Hub token the phone sent once with `transferUserInfo`. The watch keeps that token in its own keychain, never in the application context. Other brands need the phone nearby, and the camera view says so.

### Building
- The watch app is an `@bacons/apple-targets` **`watch`** target (v5 `README.md`, "watch: Watch App (with companion iOS App)"). At prebuild, the plugin creates a watchOS application target (`SDKROOT=watchos`, `WKCompanionAppBundleIdentifier` = the iPhone app). It adds the target to the iPhone app's **Embed Watch Content** phase and as a dependency (`build/with-xcode-changes.js`). The bundle id is `com.zachadams.sightline.watch`. The plugin also adds the target to `extra.eas.build.experimental.ios.appExtensions`, so EAS signs it.
- watchOS 10+. The icon and accent color are generated at prebuild into `targets/watch/Assets.xcassets`, which git ignores. `targets/watch/Info.plist` adds `WKApplication`, keeps the watch app tied to the iPhone app, and allows plain-HTTP Hub addresses on the home network.
- **CI** (`ios-compile.yml`) now builds with only `-destination 'generic/platform=iOS Simulator'`, with no `-sdk iphonesimulator`. The `-sdk` flag would force the watch target onto the iPhone SDK. Without it, Xcode builds the embedded watch app for the watchOS simulator, the same way an archive builds it for devices. The workflow makes sure the watchOS platform is installed (`app/scripts/ensure-watchos-sdk.sh`, which runs `xcodebuild -downloadPlatform watchOS` only when the platform is missing). It also checks that `Sightline.app/Watch` exists after the build. The EAS `eas-build-pre-install` hook runs the same SDK check.
- **TestFlight**: the watch app is inside the iPhone build, so the normal release builds it. The first build after this change needs `.\scripts\release-ios.ps1 -FirstRun` (interactive), so EAS can create the provisioning profile for `com.zachadams.sightline.watch`. After that, `.\scripts\release-ios.ps1` works as before. On the iPhone, the Watch app installs it automatically ("Automatic App Install"), or the user taps Install in the Watch app.

### Native pieces to check on the first CI run
The CI check couldn't run while this was written, so its first run is the real compile test of:
- `app/targets/watch/*.swift` (SwiftUI, WatchConnectivity, `WKNotificationScene`, `WKUserNotificationHostingController`)
- `app/modules/watch-bridge/ios/WatchBridgeModule.swift`
- the watch target in the iOS workspace

If the watch target ever blocks a release, the fastest way out is to move `app/targets/watch` aside. The plugin only builds folders that have an `expo-target.config.js`. The rest of the code checks whether the watch is paired and the app installed, and does nothing otherwise.

## Apple TV

### Approach and why
Options for an Expo SDK 57 project, as of 2026:

1. **react-native-tvos + `@react-native-tvos/config-tv` in the same project.** Expo's official TV path: alias `react-native` to `react-native-tvos`, set `EXPO_TV=1`, and prebuild generates a tvOS project ([Expo: Building for TV](https://docs.expo.dev/guides/building-for-tv/)). EAS supports it with a profile that sets `EXPO_TV=1`. The catch is that the iPhone app would then build on the TV fork of React Native, and many of its native pieces don't exist on tvOS. These include react-native-webview (MSE live view), expo-camera, the WireGuard/gateway xcframework, widgets, the watch app and Live Activities. Every one of them would need gating, and the free iOS CI check would be testing a different React Native.
2. **A native SwiftUI tvOS app target in the iOS Xcode project.** It has the smallest runtime, but `@bacons/apple-targets` has no tvOS app type, so it would need a custom config plugin. A tvOS target with the same bundle id inside the iOS project also confuses EAS signing.
3. **A separate Expo project for TV (`tv/`) on react-native-tvos.** ✅ **Chosen.** It is the officially supported EAS path, a profile with `EXPO_TV=1` ([Expo guide](https://docs.expo.dev/guides/building-for-tv/)). `react-native-tvos@0.86.3-0` matches the app's React Native 0.86.3 (npm dist-tag `0.86-stable`). `@react-native-tvos/config-tv@0.1.7` handles the tvOS project, icons and Top Shelf (its README). Because it is its own project, nothing in `app/` changes: the iPhone build and its CI check are untouched. It has its own free CI check (`tvos-compile.yml`) and its own EAS build.

**Live video on tvOS.** tvOS has no WKWebView, so the phone's WebView MSE player can't run there. The TV plays **HLS in AVPlayer** through `expo-video`, whose podspec targets `:tvos => '16.4'`. HLS comes from a new Hub route that works for every brand:

- `GET /v1/cameras/{id}/live.m3u8` (`bridge/hls_live.go`, documented in `docs/HUB_API.md`). It works the same way as go2rtc's own HLS (`internal/hls` in go2rtc v1.9.14). The fMP4 stream the Hub already produces for the MSE WebSocket (Frigate's go2rtc, or the Hub's own RTSP restream for other brands) is buffered per viewer. Each segment request takes what arrived since the last one, and the playlist always lists the next two segments. Sessions are tied to the grant and camera that started them and end about 10 seconds after the player stops asking. At most 16 run at once. Tests are in `bridge/hls_live_test.go`.
- Frigate's go2rtc also serves `api/stream.m3u8`, but that sits behind Frigate's auth and wouldn't cover other brands. Going through the Hub keeps one code path and enforces the grant.
- If HLS fails, the TV shows a snapshot that refreshes every 2 seconds instead.

### What it does (MVP)
- **Sign in by QR, no cloud** (`tv/modules/tv-pairing`, `tv/src/PairScreen.tsx`, `app/src/app/tv.tsx`, `app/src/tv/link.ts`):
  1. The TV listens on a random port on the home network (Network.framework `NWListener`). It shows a QR code for `sightline://tv?h=<tv-ip:port>&k=<one-time key>&n=Apple TV`.
  2. The iPhone's Camera app (or Sightline's scanner) opens Sightline, which asks "Show your cameras on Apple TV?". Sightline creates a **`live` grant** on the user's Hub (live view and snapshots of all cameras, nothing else). It POSTs the one-time invite code, the key and the Hub's addresses to `http://<tv>/pair`. The phone only sends to private IPv4 addresses.
  3. The TV redeems the invite at the Hub (`POST /v1/redeem`) and gets its **own token**, which it keeps in the tvOS keychain. The phone shows "connected". The TV appears in Settings → Sharing as "Apple TV", where it can be removed. Removing it signs the TV out, and the TV offers to connect again.
  - Security: the invite code is one-time and redeemed within seconds. The TV checks the key in constant time and accepts only `POST /pair`. Its listener stops once paired.
- **Camera grid**: 2×2 or 3×3 (button at the top), focusable tiles with a violet focus ring, snapshots refreshing every 5 seconds without flashing (the next frame is prefetched). The first tile has preferred focus.
- **Full-screen live**: select a tile. Left/right on the remote switches cameras. Menu goes back to the grid, and Menu on the grid goes to the Home Screen.
- The TV picks the Hub's home address when it can reach it, and otherwise its public link.

### Building and releasing the TV app
```powershell
cd tv
npm ci
npx tsc --noEmit; npm test
# Free compile check: GitHub → Actions → "tvOS compile check" → Run workflow
cd ..
.\scripts\release-ios.ps1 -TV -FirstRun   # first time (tvOS provisioning profile)
.\scripts\release-ios.ps1 -TV             # later
```
- `tv/eas.json` `production` sets `EXPO_TV=1`. `tv/app.json` also sets `isTV: true`, so the project always prebuilds for tvOS.
- **Universal purchase**: the TV app uses the same bundle id (`com.zachadams.sightline`) and the same App Store Connect app (`ascAppId 6821496506`). Before the first upload, add the platform once in App Store Connect: App → "+" next to iOS → **tvOS**. TestFlight then shows a separate tvOS build train. `tv/app.json` uses the same EAS project id, so build numbers come from the same remote counter. The numbers simply skip, which is fine.
- `npm ci` in `tv/` needs the `overrides` in `tv/package.json`. Without them, `@react-native-tvos/virtualized-lists` pulls in a second, stock `react-native`.
- Icons and Top Shelf images are generated from the app logo by `tv/scripts/make-tv-images.js` (exact tvOS sizes in `tv/assets/tv`). They are a placeholder until real layered artwork exists.

## What remains
- **First CI runs.** The watch target, `watch-bridge`, the TV project and `tv-pairing` are Swift that could not be compiled here (Windows). Run "iOS compile check" (automatic on push to `main`) and "tvOS compile check" (manual) before spending EAS credits.
- **First signed builds** need `-FirstRun` once each: the watch profile, and the tvOS profile plus adding the tvOS platform in App Store Connect.
- **TV without a Hub**: not supported. The TV app talks only to a Sightline Hub, which is what makes it work for every brand. The phone explains this when there's no Hub it can share from (owner or full access).
- **Watch without a Hub and without the phone nearby**: only Hub cameras refresh. Other brands show the last snapshot and a "bring your iPhone closer" hint.
- **Not built yet**: watch complications or Smart Stack widget, TV audio controls and two-way talk, TV PTZ, TV recordings and timeline, TV Top Shelf content (live snapshots), and layered TV icon art.
- **HLS live** is tested against a fake go2rtc upstream (`hls_live_test.go`) but not yet on a real Apple TV. Expect about 1–2 seconds of latency, similar to go2rtc's HLS. Video is H.264/H.265 with AAC; other audio codecs are dropped (video still plays).
