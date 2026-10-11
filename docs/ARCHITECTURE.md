# Architecture

App name: **Sightline**. Bundle ID: `com.zachadams.sightline`.

## Repo layout

```
app/        Expo (SDK 57) app — iOS first, Android later
bridge/     Optional "Instant Alerts" Docker container (Frigate MQTT -> Expo Push)
tunnel/     Go source for the in-process WireGuard tunnel (wireguard-go + netstack)
docs/       This file, setup guides, release checklist
scripts/    PowerShell build / release helpers (EAS -> TestFlight)
```

## Goals

1. Live view, recording review, PTZ, alerts — for Frigate first, other systems via adapters.
2. Built-in VPN that never touches the system VPN toggle.
3. Fast: thumbnails in < 300 ms on LAN, live video in ~1 s, scrubbing feels instant.
4. Beautiful and customizable: themes, accent colors, phone stack layout, iPad custom grid.

## Camera system adapters

Every system implements one `CameraSystemAdapter` interface (`app/src/systems/types.ts`)
and advertises its capabilities so the UI only shows what works:

| System        | Live | Review | Events | PTZ | Snapshots | Notes |
|---------------|------|--------|--------|-----|-----------|-------|
| Frigate       | ✅   | ✅     | ✅     | ✅  | ✅        | HTTP API + go2rtc. First-class. |
| Generic RTSP / IP | ✅ | ❌   | ❌     | ONVIF later | ✅ if snapshot URL | Live-only |
| Reolink       | ✅   | ✅     | ✅     | ✅  | ✅        | HTTP CGI API (NVR + standalone) — phase 2 |
| UniFi Protect | ✅   | ✅     | ✅     | ✅  | ✅        | Local API — phase 2 |
| Blue Iris     | ✅   | ✅     | ✅     | ✅  | ✅        | JSON API — phase 3 |
| Hikvision / Dahua / Amcrest | ✅ | ✅ | ✅ | ✅ | ✅ | ISAPI / CGI — phase 3 |
| Shinobi, ZoneMinder, Agent DVR, Scrypted | | | | | | phase 3+ |

Onboarding asks "What are you running?" and shows all of these; unsupported ones say
"coming soon" and fall back to Generic RTSP.

## Video pipeline

- **Grid tiles:** Frigate `latest.webp` snapshots refreshed 1–2 fps per visible tile
  (cheap, instant, scales to 16+ cameras). Off-screen tiles pause.
- **Focused live:** go2rtc MSE over WebSocket (`/live/mse/api/ws`) through the gateway, played in a
  WKWebView with ManagedMediaSource (iOS 17.1+). Sub-second latency. Frigate 0.18 exposes no
  HLS for live on :8971, and WebRTC media would bypass the in-app tunnel.
- **Generic RTSP:** embed go2rtc (Go) in the tunnel library to restream RTSP as MSE (next milestone).
- **Review:** Frigate VOD HLS (`/vod/<camera>/start/<ts>/end/<ts>/index.m3u8`) played in
  `expo-video`; a timeline scrubber built from `/api/review` + `/api/<cam>/recordings/summary`
  with event markers; thumbnails from `/api/review/<id>/preview`.
- **Doorbell case:** every alert opens straight to the clip at `start_time - 5s`.

## Built-in VPN (no system toggle)

The WireGuard tunnel runs **inside the app process** using wireguard-go's userspace
`netstack`; there is no NetworkExtension, so no VPN icon or iOS toggle, and the user's
other VPNs are untouched.

```
expo-video / fetch / WebView  ->  http://127.0.0.1:<port>/...   (one loopback port per system)
                          -> netstack TCP dial -> WireGuard UDP -> home router -> Frigate
```

- Go library in `tunnel/` exposes `Start(config) -> port`, `Stop()`, `Status()`; built with
  `gomobile bind` into an xcframework (iOS) and an .aar (Android, reused later).
- Wrapped as an Expo local module (`app/modules/wg-tunnel`).
- The gateway also logs in to Frigate, injects the Bearer token, re-logs in before expiry,
  adds the CSRF header, accepts self-signed certs, and passes WebSockets through. It
  dials directly on home Wi-Fi and through WireGuard when away, so the app uses one URL.
- A **connection manager** decides per system: on home Wi-Fi (LAN host reachable) go
  direct; otherwise bring the tunnel up. The tunnel starts on app foreground and stops
  a short grace period after backgrounding.
- Import config via `.conf` file, pasted text, or QR scan (`expo-camera`).
- Keys are stored in the iOS Keychain (`expo-secure-store`).
- The xcframework is built on macOS (EAS pre-install hook or GitHub Actions); the user
  never needs a Mac.

## Alerts (two tiers, user picks)

1. **Built-in (default, zero setup):** an alerts inbox that syncs Frigate review items on
   foreground, plus `expo-background-task` that wakes periodically, connects, pulls new
   items, applies the user's rules, and posts local notifications. iOS controls the timing,
   so delivery is **delayed** (usually 15 min–hours).
2. **Instant Alerts (optional):** `bridge/` container next to Frigate subscribes to MQTT
   `frigate/reviews`, applies the same rules (synced from the app over the tunnel), and
   sends a text-only push via the free Expo Push Service. No images leave the network;
   tapping fetches the clip over the tunnel. The app generates the compose snippet.

Rules: per camera, object label, zone, severity (alert/detection), quiet hours, and cooldown.

## Layout & customization

- Phone: vertical stack (1 or 2 columns), drag to reorder, hide cameras.
- iPad: free-form grid editor (12-col grid, tiles span N×M, saved as multiple named views
  such as "Outside" and "Night").
- Themes: Light / Dark / OLED black, accent color, tile corner radius, label style,
  density. Stored locally per device.

## Build & release

- EAS Build (`production` profile) -> `eas submit` -> TestFlight (internal testers group).
  No device UDID registration needed.
- `scripts/release-ios.ps1` runs build + submit in one command.
- Android follows after iOS stabilizes (same codebase; the tunnel .aar is already built
  from the same Go code).

## Camera map

- `cameraMap` in the store holds: an optional background image (floor plan or satellite screenshot), per-camera placements (x/y 0–1, heading, field of view), and walking links with transit times.
- `map/graph.ts`:
  - `neighborsOf()` returns linked cameras first, then the nearest placed cameras.
  - `tracePath()` follows an event to the next camera whose event starts within the transit window.
- Uses:
  - Map tab: live activity glow.
  - Playback: synced PiP of up to 2 neighbors, plus a "Next seen on X" jump.

## Full-history playback

- Day chips list every day the NVR has (`/api/recordings/summary`). A 24 h overview strip shows coverage and events; tap it to jump.
- The detail timeline (3 zoom levels) shows recordings, a motion histogram (`/api/review/activity/motion`) and event pins. Object filter chips filter the pins and next/previous navigation.
- The VOD window is ±30 min around the playhead and re-centers on seek. Wall↔player time mapping skips recording gaps (`util/vod-time.ts`).
- Share exports this event, 30 s or 2 min to MP4 (`/api/<cam>/start/<s>/end/<e>/clip.mp4`) and opens the iOS share sheet.

## Alert masks

- Polygons are drawn per camera on a snapshot (`settings/masks`).
- An alert is suppressed only if every observed foot position of its objects is inside a mask; unknown positions never suppress.
- Built-in alerts use Frigate `path_data` or the box from `/api/events/<id>`. The bridge tracks boxes from MQTT `frigate/events`, normalized with the camera's detect size, which the app syncs.

## Rich notifications

- Built-in alerts (local) attach the review preview MP4 once the event has ended (it plays on expand), otherwise a snapshot.
- Instant Alerts:
  - The bridge embeds a ~1.6 KB JPEG thumbnail, AES-256-GCM encrypted with a key derived from the pairing secret. Apple/Expo only see ciphertext.
  - The Notification Service Extension (`targets/notification-service`) first tries a full-size snapshot from the bridge (home network only), then falls back to decrypting the inline thumbnail.
  - The secret and bridge URL are shared through an App Group keychain item.
- Apple Watch mirrors iPhone notifications, including image attachments (to verify on device).
- Next: a VPN-backed fetch inside the extension for full-res images and clips when away (24 MB memory limit to evaluate).

## Lock Screen Live Activities

- A doorbell ring ("Someone's at the door · Front Door", snapshot, Watch → `sightline://doorbell?…`) or an ongoing camera event (what was seen, elapsed time, latest snapshot → `sightline://camera/<key>`) shows as a Live Activity on the Lock Screen and in the Dynamic Island. Setting: Alerts → "Show on Lock Screen" (on by default).
- Layout: `targets/widget/LiveActivity.swift` (in the widget extension). Start/update/end: `modules/live-activity` (native) and `src/alerts/live-activity.ts`. The `SightlineActivityAttributes` struct exists in both and must stay identical (a test compares them).
- Snapshots are downscaled to a ≤240 px JPEG in the App Group (`live/…`); the activity state only carries the path, well under ActivityKit's 4 KB.
- Local start only. Rings/events start one when the app sees them itself (in-app doorbell poll, an alert notification received while the app runs, or a background check while the app is open). iOS refuses to *start* an activity from the background, but a background check can update or end a running one. Activities end themselves after 3 min (ring) / 5 min (event), or once the event is seen to end (shown as "Ended" for a minute when the app is open); leftovers are cleaned up when the app becomes active.
- No remote start: Live Activity pushes (push-to-start / update tokens, `apns-push-type: liveactivity`) must go straight to APNs, signed with the app developer's APNs key. The Expo Push Service has no Live Activity support (its message format has no such fields, and Expo's own Oct 2026 Live Activities guide calls APNs directly with a `.p8` key). Every Hub would need that key, which can't be handed out, and Sightline has no cloud server by design. Revisit if Expo's push service adds Live Activity messages.

## RTSP cameras

- go2rtc's `pkg/rtsp` + `pkg/mp4` are embedded in the tunnel library. Each camera gets a loopback `/api/ws` that speaks go2rtc's MSE protocol, so the same live player works.
- RTSP dials a loopback TCP forwarder that reaches the camera directly or through WireGuard.

## App lock

- Optional Face ID / Touch ID with the iPhone passcode as fallback, or an app-only 6-digit PIN (salted SHA-256 in the Keychain) with optional Face ID.
- Relock delay is configurable. The app-switcher preview is covered.
- Uses a native Modal so it also covers full-screen camera modals.
