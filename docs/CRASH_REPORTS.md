# Crash reports and diagnostics

Sightline has no server of its own, and cameras are sensitive, so crash reporting follows three
rules:

1. **Nothing leaves the phone unless the user taps Send.** No background upload, no analytics.
2. **Brand + feature + error category, never identity.** No IPs, host names, URLs, usernames,
   passwords, tokens, emails, camera or system names, pictures or video.
3. **Free, and no account for the user.**

## Options considered

### (a) Apple-native: App Store Connect / Xcode Organizer + MetricKit — chosen

- **Crash logs from TestFlight and App Store users** reach App Store Connect and the Xcode
  Organizer (Window → Organizer → Crashes) for users who have *Share With App Developers*
  turned on (iOS Settings → Privacy & Security → Analytics & Improvements). Free, no SDK, Apple
  symbolicates them against the uploaded dSYMs. TestFlight testers can also attach a crash
  report and comment from the TestFlight crash prompt.
  Sources: [Acquiring crash reports and diagnostic logs](https://developer.apple.com/documentation/xcode/acquiring-crash-reports-and-diagnostic-logs),
  [Viewing tester feedback (App Store Connect)](https://developer.apple.com/help/app-store-connect/test-a-beta-version/view-tester-feedback),
  [Apple: Analytics & Privacy](https://www.apple.com/legal/privacy/data/en/analytics/).
  An app **can't** turn this setting on, so Settings → Privacy → *Share crash data with the
  developer* explains where it is.
- **MetricKit** (iOS 14+) delivers `MXDiagnosticPayload`s (crash, hang, CPU-exception,
  disk-write-exception, and from iOS 16 app-launch diagnostics, each with a call-stack tree) to
  the app itself through `MXMetricManagerSubscriber.didReceive(_:)`; since iOS 15 diagnostics
  arrive on the next launch rather than once a day, and `MXMetricManager.pastDiagnosticPayloads`
  returns ones delivered earlier. This works for **every** user, not only those sharing
  analytics, but only reaches us if the user sends it.
  Sources: [MetricKit](https://developer.apple.com/documentation/metrickit),
  [MXDiagnosticPayload](https://developer.apple.com/documentation/metrickit/mxdiagnosticpayload),
  [pastDiagnosticPayloads](https://developer.apple.com/documentation/metrickit/mxmetricmanager/pastdiagnosticpayloads),
  [WWDC20: What's new in MetricKit](https://developer.apple.com/videos/play/wwdc2020/10081/),
  [WWDC21: Diagnose Power and Performance regressions in your app](https://developer.apple.com/videos/play/wwdc2021/10087/).

### (b) JavaScript errors — chosen

A React Native JS exception is not a native crash: in a release build an unhandled fatal JS
error becomes an `RCTFatalException` native crash (so it *does* show up in Organizer, but only as
"Unhandled JS Exception: …" with a native stack), and non-fatal errors and render errors leave no
trace at all. So the app also:

- installs a global handler (`ErrorUtils.setGlobalHandler`, chaining to React Native's own) and,
  in release builds, Hermes' unhandled-promise-rejection tracker;
- exports a root `ErrorBoundary` from `app/_layout.tsx` (Expo Router wraps the route in a React
  error boundary: [Expo Router error handling](https://docs.expo.dev/router/error-handling/)),
  showing "Something went wrong — Try again / Send report" instead of a broken screen.

### (c) Third-party services (Sentry, Bugsnag, Crashlytics…) — documented, not built in

- [Sentry](https://sentry.io/pricing/) has a free Developer plan (one user, 5k errors/month);
  [Bugsnag](https://docs.bugsnag.com/platforms/react-native/expo/) and Firebase Crashlytics are
  similar. All of them need an account and DSN/API key, send data to a third party
  automatically (Sentry's defaults include device and network context; IP collection depends on
  `sendDefaultPii` and server-side settings), and their React Native SDKs ship **native** crash
  reporters (`@sentry/react-native` bundles sentry-cocoa and an Expo config plugin). That's a
  native dependency, a new EAS build, and an always-on third-party data flow, which goes against
  "no data leaves the phone without Send". So there's **no Sentry hook in the app**.
  If one is ever wanted: `npx expo install @sentry/react-native`, add its config plugin, call
  `Sentry.init({ dsn, sendDefaultPii: false, beforeSend })` only when the user opts in, and pass
  every event through `scrubText` from `app/src/diagnostics/core.ts` in `beforeSend`.

## What was built

| Piece | Where |
| --- | --- |
| Scrubbing, error categories, endpoint shapes, ring buffer, report format (pure, tested) | `app/src/diagnostics/core.ts`, `app/test/diagnostics.test.ts` |
| On-phone event log (150 newest, repeats folded, persisted in expo-sqlite kv-store), global JS handler | `app/src/diagnostics/log.ts` |
| Report gathering (events, MetricKit, Hub), Mail (`mailto:`) and share-sheet file | `app/src/diagnostics/send.ts` |
| "Something went wrong" screen (root ErrorBoundary) | `app/src/diagnostics/error-screen.tsx` |
| Settings → Help → Report a problem (note, preview, toggle, send) | `app/src/app/settings/report.tsx` |
| Settings → Privacy → Share crash data with the developer (explainer) | `app/src/app/settings/crash-data.tsx` |
| MetricKit collector (native, iOS 14+ APIs; keeps newest 20 payloads in Application Support) | `app/modules/metrickit` |
| Hub: `GET /v1/diagnostics` (owner only), scrubbed backend errors by brand | `bridge/diagnostics.go`, `bridge/diagnostics_test.go` |
| Support address (placeholder, **set before release**) | `SUPPORT_EMAIL` in `app/src/config.ts` |

### What gets recorded

| Area | Recorded | Example |
| --- | --- | --- |
| `connect` | brand, path tried (home-network / vpn / remote / route), category | `reolink  home-network  timeout ×3` |
| `adapter` | brand, request **shape** (IDs, camera names and query strings dropped; Reolink `cmd`/Dahua `action` kept), category, HTTP status | `hikvision  /ISAPI/Streaming/channels/*  auth  — HTTP 401` |
| `player` | brand, player (live-start / live-mse / live-hls / live-mjpeg), category | `frigate  live-mse  codec` |
| `tunnel` | start failures, category | `tunnel  start  vpn` |
| `js` | scrubbed message + first stack frame, fatal / error / unhandled-promise / screen-crash | `js  fatal — TypeError: … @ render (main.jsbundle:1:2345)` |

Network/adapter/player entries keep **no free text** at all, only the category (and HTTP status).
JS errors keep a scrubbed message. Everything is scrubbed again when the report is built, with
the current system/camera/group/clip names and usernames as extra words to remove.

### The report

The preview on the Report screen is exactly the text that's emailed. "Email report" opens Mail
to `SUPPORT_EMAIL` with the readable report as the body (shortened past 6,000 characters to stay
openable); "Share as file" opens the share sheet with a `.txt` that also carries the raw (scrubbed)
MetricKit JSON for symbolication. The *Include diagnostics automatically when I report a problem*
toggle (on by default) limits the report to the user's note plus app/iOS versions when off.
No new npm dependencies were added: Mail uses `mailto:` and the file uses `expo-sharing`.

## Not verified

- The MetricKit module and the rest of the native build: needs the GitHub iOS compile check and
  a device. MetricKit only delivers on real devices (not the simulator), and crash diagnostics
  arrive on the launch *after* a crash.
- `mailto:` length limits on iOS Mail (kept conservative; the file route has no limit).
- Hermes' `enablePromiseRejectionTracker` in release builds (wrapped in try/catch; harmless if absent).
