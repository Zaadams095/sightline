# App Review notes

> The full, submit-ready review notes (Demo mode plus WireGuard / guideline 5.4, Always
> location, background modes and permissions) are in
> [APP_STORE_LISTING.md → App Review information](APP_STORE_LISTING.md#13-app-review-information),
> with the rest of the App Store listing. This file keeps the Demo mode details.

Sightline shows video from security cameras and recorders that people already own and run at
home (Frigate, Reolink, Hikvision, Dahua/Amcrest/Lorex, UniFi Protect, Blue Iris, ONVIF
cameras and more). It has no accounts and no cloud service, so a reviewer without cameras can't
connect to real ones. **Demo mode** fills that gap: built-in sample cameras that work with no
network and no setup.

## Text for App Store Connect → App Review Information → Notes

> Sightline connects to security cameras and recorders on the user's own home network. There is
> no account or sign-in.
>
> To review the app without cameras, tap **"Try it with sample cameras"** on the first screen
> ("No cameras handy?"). This adds five built-in sample cameras (Front Door doorbell, Driveway,
> Backyard, Garage, Living Room) with sample video and a week of sample events. Everything works
> offline; nothing is sent anywhere. Sample cameras are always marked **SAMPLE**.
>
> Things to try:
> 1. **Live** tab: all cameras play at once. Tap one for full screen.
> 2. In **Driveway**, tap **Move camera** and hold the arrows or zoom buttons, or tap a preset
>    (the sample view pans and zooms).
> 3. Tap **Recordings** on a camera, or open the **Recordings** tab, to see events (person,
>    package, car, dog, doorbell ring). Tap an event to watch it; drag the timeline to scrub.
> 4. **Recordings → Search**: try "package", "dog in the yard" or "Sam".
> 5. A star saves a moment; the share button exports the clip.
> 6. **Map** tab: the sample cameras on a property map.
> 7. To see a notification: when asked "See what an alert looks like?", tap **Send one** (or
>    Settings → Sample cameras → Send a sample alert). One sample alert arrives a few seconds
>    later; tapping it opens that recording. The app never sends sample alerts on its own.
>
> To leave Demo mode: Settings → Sample cameras → Remove sample cameras, or tap "Connect my real
> cameras" on the banner.
>
> Permissions: Local Network (to reach cameras at home; not needed for the sample cameras),
> Camera (only to scan a QR code), Notifications (alerts), Location (optional "Home & Away",
> only when the user turns it on).

## How it works (for us)

- `demo` system kind with `DemoAdapter` (`app/src/systems/demo/`). Events are generated from
  absolute time slots relative to now (`data.ts`), so the app always shows recent activity with
  stable ids. Tests: `app/test/demo.test.ts`.
- Footage lives in `app/assets/demo` (about 4 MB). It is drawn from simple shapes by
  `app/scripts/demo-media/` (no stock footage, no third-party license). Regenerate with
  `powershell -File app/scripts/demo-media/make-demo-media.ps1 -Ffmpeg <path to ffmpeg.exe>`.
- Live view plays a looping file (`LiveSource` kind `loop`); the Driveway file is wider than the
  view, and its move controls slide the visible window (`systems/demo/ptz.ts`).
- Sample cameras are excluded from background alert checks and the doorbell watcher, so they
  never notify unless the user taps "Send one".
- Two-way talk and lights/siren need a real camera that supports them, so Demo mode doesn't
  show them (showing a feature that real cameras can't use would mislead review).
