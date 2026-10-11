# Sightline on Android

Package `com.zachadams.sightline`. Same Expo app as iOS (`app/`), built with EAS. This page
covers what's Android-specific: push notifications, notification pictures, plain-HTTP camera
access, icons, and the iOS-only bits that have Android stand-ins.

## Push notifications: one-time Firebase setup

Expo's push service delivers to Android through Firebase Cloud Messaging (FCM). The app
builds without Firebase (no crash, the CI compile check doesn't need it), but Android phones
get no Instant Alerts or Hub pushes until these steps are done. Built-in (background-check)
alerts work either way.

1. **Create a Firebase project.** Go to <https://console.firebase.google.com>, *Add project*,
   name it "Sightline". Google Analytics isn't needed.
2. **Add the Android app.** In the project: *Add app* → Android. Package name exactly
   `com.zachadams.sightline`. Nickname "Sightline". Skip the SHA-1 and the SDK steps.
3. **Download `google-services.json`** from that screen (or Project settings → General → Your
   apps). It identifies the Firebase project; it isn't a secret key, but keep it out of git
   (it's in `app/.gitignore`).
   - For EAS builds, upload it as a file variable once (from `app/`):
     ```powershell
     npx eas-cli@latest env:create --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json --visibility secret --environment production --environment preview --environment development
     ```
   - For local builds, put it at `app/google-services.json`.
   `app/app.config.js` sets `android.googleServicesFile` from whichever is there, and leaves it
   out when neither is (no failed builds).
4. **Give EAS the FCM V1 key** (lets Expo's push service send to your Firebase project):
   1. Firebase console → Project settings → *Service accounts* → *Generate new private key*.
      This downloads a JSON key. **This one is a secret**: don't commit it, delete it after step 2.
   2. From `app/`: `npx eas-cli@latest credentials` → Android → `production` →
      *Google Service Account* → *Manage your Google Service Account Key for Push
      Notifications (FCM V1)* → *Set up a Google Service Account Key for Push Notifications
      (FCM V1)* → *Upload a new service account key* → pick the downloaded file.
   (Same thing on the web: expo.dev → project → Credentials → Android → FCM V1 service account key.)
5. **Build** a new Android binary (`scripts/release-android.ps1`, or `eas build -p android`).
   An OTA update isn't enough: the Firebase config is compiled in.

Check: with a Hub (or Instant Alerts) set up, send a test push from the app's alert settings. A Hub needs the updated `bridge` image to send the Android format.

## How Android notifications work

**Channels** (`app/src/alerts/channels.ts`, created at startup, renamed with the app language):

| Channel ID | Shown as | Importance |
|---|---|---|
| `alerts` | Camera alerts | High (heads-up, sound) |
| `doorbell` | Doorbell | Max (heads-up, longer vibration, shown on the lock screen) |
| `packages` | Packages | High |
| `checkins` | Family check-ins | High |
| `health` | Camera problems | Default (no banner) |

The Hub picks the channel per push (`bridge/push.go`, `channelId`); local notifications pass
it in their trigger (`showNow(channel)`). People can turn each one off or change its sound in
Android's settings, and Android keeps those choices.

*Doorbell and full-screen:* rings use the highest heads-up importance, not a full-screen
intent. Since Android 14, Google Play only lets calling and alarm apps hold
`USE_FULL_SCREEN_INTENT`, and a security camera app declaring it risks review trouble and a
permission the person has to grant by hand. Tapping the ring opens the full-screen call screen
as on iPhone.

**Hub pushes are data-only on Android.** A push with a title is drawn by Android itself while
the app is in the background, and then it has no action buttons (snooze, Not important, Watch,
She's fine) and no picture. So the app registers with `platform: "android"` and the Hub sends
title, text, channel and button category inside `data` (`slTitle`, `slBody`, `slChannel`,
`slCategory`; see `docs/HUB_API.md`). The app's own push service shows it:

- `app/modules/android-notify` (Kotlin) replaces expo-notifications' FCM service and its
  notification receiver (both registered at a higher priority than Expo's own, which Expo
  allows for exactly this). Non-Sightline messages go to Expo untouched.
- The notification is built by Expo's own code (so taps and buttons reach the app's response
  listener like any other), then given a **big picture**: the Hub's encrypted inline
  thumbnail (`data.thumb`, AES-GCM with `SHA256("sightline-thumb-v1:" + key)`, as on iOS),
  decrypted with the key the app stores through `WgTunnel.setShared("bridge.secret")`
  (Keystore-sealed, `SharedStore`). Built-in alerts pass a downloaded snapshot as
  `data.androidImage`. If anything about the picture fails, the text notification shows.
- **Sealed alert text.** The app registers with `caps: ["enc-msg-v1"]` (all platforms), so an
  updated Hub puts only generic text in `slTitle`/`slBody` ("Activity on your cameras",
  "Doorbell"…, in the phone's language), replaces `slGroup` with an opaque hash, and moves the
  real title, text, thread and every data field into `data.enc`: AES-256-GCM,
  base64(nonce ‖ ciphertext ‖ tag), key `SHA256("sightline-msg-v1:" + bridge.secret)`, plaintext one
  flat JSON object of strings `{"v":"1","title","body","threadId",…data keys}`
  (`bridge/seal.go`). `SightlinePush.openSealedMessage` merges it over the visible data and
  maps title/body onto `slTitle`/`slBody`; `slPush`, `slChannel`, `slCategory` and `thumb`
  stay visible. If it can't be opened, the generic text shows and the app opens `data.enc`
  itself when the notification is tapped (`app/src/alerts/sealed.ts`). Older Hubs ignore the
  cap and keep sending plaintext.
  **To check on a device** (not yet done; the format is covered by
  `bridge/seal_test.go TestSealedAndroidDataOnly`, which mirrors the Kotlin merge): with an
  updated Hub, send a test push and trigger a camera alert with the app in the background and
  closed; the notification must show the real title ("Person · Front Door"), buttons and
  picture, and tapping it must open the clip. If it shows "Activity on your cameras", read
  `adb logcat -s SightlineNotify`.
- Buttons that don't open the app (snooze, Not important, I got it, She's fine) work with the
  app closed through a headless task (`NOTIFICATION_ACTION_TASK` in `background.ts`), are
  acted on once, and take the notification down.

## Plain HTTP to cameras

Android blocks `http://` by default. `app/plugins/with-android-network-security.js` adds a
network security config that allows it everywhere: cameras and recorders are reached at LAN
addresses people type or the app finds (no fixed list, and the config format can't express IP
ranges), the tunnel gateway is `http://127.0.0.1:<port>`, and Metro is plain HTTP in
development. Certificates are still checked against the system store.

**Android 17 local network permission.** Apps that *target* Android 17 (SDK 37) need the
`ACCESS_LOCAL_NETWORK` runtime permission ("Nearby devices") to reach LAN devices. Sightline
targets SDK 36 (Expo SDK 57's default), where Android grants it implicitly, and Google asks
apps not to declare it before targeting 37. When moving to SDK 37: add
`"android.permission.ACCESS_LOCAL_NETWORK"` to `android.permissions` in `app.json`. Then
`ensureLocalNetworkAccess()` (`app/src/net/local-network.ts`) asks for it before Find my
cameras, and explains how to turn it on in Settings if it was refused. Check the tunnel's
own LAN connections then too (loopback and the VPN aren't covered; direct LAN dials are).

## Backups

`android.allowBackup` is `false` (`app.json`): Android's automatic backup to Google Drive
(and adb backups) would otherwise copy the app's files, including familiar-face feature prints
(`Documents/familiar`), which Sightline promises stay on the phone. Moving to a new phone uses's own Wi-Fi transfer or passcode-protected backup file instead (`app/src/backup`).

## Icons and splash

- Adaptive icon (`app/assets/images/android-icon-*.png`, 1024²): the logo (from
  `icon-dark.png`, its glow included) scaled into the 66 dp safe zone on a transparent
  foreground; a dark navy (`#080A14`) background with a faint purple lift; a monochrome
  white house-and-lens silhouette for themed icons. `notification-icon.png` (96², white on
  transparent) is the status-bar icon.
- Splash: same `splash-logo.png` on `#080A14`. Android 12+ shows the splash icon in a circle
  of 2/3 of a 288 dp square, so Android uses `imageWidth: 288` (the logo, ~47 % of the image,
  stays well inside; the feathered edges are the background color, so the circle doesn't show).

## iOS-only APIs and their Android stand-ins

- `ActionSheetIOS` → `showActionSheet` and `Alert.prompt` → `showPrompt`
  (`app/src/components/ui/action-sheet.tsx`): native on iOS, a themed bottom sheet / dialog
  on Android (drawn by `<DialogHost />` in the root layout).
- SF Symbols → `SymbolView` from `@/components/ui/symbol`: same props, maps each SF name to a
  Material Symbol (expo-symbols draws Material Symbols on Android). `test/android.test.ts`
  fails when an icon has no Android twin. Tab icons use `md=` names.
- Android Back on the wall display goes through its lock; on the doorbell call it goes home
  when there's nothing behind (`useAndroidBack`). Other full-screen screens close normally.
- Live Activities, widgets, Siri, the Watch and iCloud backup are iOS-only modules
  (`requireOptionalNativeModule` → `null` on Android, already guarded).
