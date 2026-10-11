# Sightline

A private, local-first mobile app for self-hosted camera systems. It offers live view, recording review, PTZ and alerts, with WireGuard built into the app.

- `app/`: Expo (SDK 57) app, iOS first. The Apple Watch app is in `app/targets/watch`.
- `tv/`: Apple TV app (a separate Expo project on react-native-tvos; it talks to a Sightline Hub)
- `tunnel/`: Go userspace WireGuard and the loopback gateway, compiled into the app
- `bridge/`: optional Instant Alerts container (Frigate MQTT → push)
- `docs/`: [Architecture](docs/ARCHITECTURE.md), [Frigate API notes](docs/FRIGATE_API.md), [Apple Watch & Apple TV](docs/APPLE_WATCH_TV.md)
- `scripts/`: PowerShell build and release helpers

## First TestFlight build (Windows / PowerShell)

1. `.\scripts\setup-eas.ps1`: log in to Expo and link the EAS project. This writes `extra.eas.projectId` to `app/app.json`, which push notifications need.
2. Commit everything. EAS builds the committed git tree.
3. `.\scripts\release-ios.ps1 -FirstRun`: EAS asks for your Apple ID once. It creates the certificates and push key, builds on a cloud Mac (including the Go tunnel), and submits to TestFlight.
4. In App Store Connect → TestFlight, add yourself to an **internal testing** group. No device registration is needed.
5. Later builds: `.\scripts\release-ios.ps1`

## Tests

```powershell
cd app; npx tsc --noEmit; npx expo lint
cd tunnel; go test ./...   # includes a real WireGuard end-to-end test
cd bridge; go test ./...
```
