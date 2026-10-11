# Sightline platform plan

**Principles:**
1. Every brand is first-class. Frigate is just one backend among many.
2. A non-technical person can set everything up with no terminal, config files or jargon.
3. No cloud server of our own; enforcement happens at home.

## 1. Two ways the app reaches cameras

| | Direct | Via Sightline Hub |
|---|---|---|
| App talks to | The NVR, VMS or cameras themselves (per-brand adapters in `app/src/systems/`) | The Hub's single, brand-neutral API (`HubAdapter`) |
| Remote | Home Wi-Fi, or the user's own WireGuard (Advanced) | Tailscale Funnel public HTTPS URL (no router setup, works behind CGNAT) |
| Alerts | Built-in background checks (delayed) | Instant push from each brand's event stream |
| Sharing | Full/Household as NVR user accounts, where supported | All four access types, enforced by the Hub |

The Hub runs on any always-on box (Home Assistant add-on, Docker, Raspberry Pi image) and wraps one or more systems.

## 2. App adapter contract (brand-neutral)

`CameraSystemAdapter` is in `app/src/systems/types.ts`. The UI renders only what `capabilities` says a system supports.

### Live: `liveStream(cameraId, {quality}) → LiveSource`
- `{ kind: 'mse', wsUrl }`: go2rtc WebSocket MSE (Frigate, Hub, and anything restreamed).
- `{ kind: 'rtsp', url }`: an RTSP URL. The app restreams it in-process (`tunnel/wgtunnel/rtsp.go`) into `mse`. **Most NVRs and IP cameras use this.**
- `{ kind: 'hls', uri }`: HLS that AVPlayer plays directly (for example Blue Iris).
- `{ kind: 'mjpeg', uri }`: last resort (ZoneMinder, Shinobi); shown in an image view.

`resolveLive()` in `app/src/systems/live.ts` turns any `LiveSource` into something the player can show.

### Recordings: `playback(cameraId, start, end) → PlaybackSource`
- `{ kind: 'vod', uri }`: seekable HLS covering the window with gaps removed. Uses `recordingSegments()` for wall-clock mapping (Frigate, Hub).
- `{ kind: 'stream', source: LiveSource | {kind:'file', uri} }`: plays **from `start` forward**. Seeking reopens the source at the new time (`playback(cameraId, t, …)`). Wall clock = start + elapsed playback.
  - Hikvision/Dahua: RTSP playback URLs with a start time.
  - UniFi: MP4 export of the window.
  - Blue Iris: per-clip files.

### Everything else is optional and capability-gated
- `listReview`/`events`, `recordingSegments`, `recordingDays`, `motionActivity`
- `ptz` (vendor API, or ONVIF for IP cameras)
- `search`, `knownNames`, `groups`, `health`, `retain`, `clip`

### Descriptors drive setup
`SystemDescriptor` (`app/src/systems/catalog.ts`) defines:
- the plain-language name, a "where to find the address" hint, and default ports
- the **setup fields** (address, username/password, sometimes an API key)
- **discovery fingerprints** (ports plus an HTTP check)

Onboarding is one generic screen built from the descriptor. "Find my cameras" scans the local network and suggests matches. Frigate gets no special screen.

## 3. Discovery (no special entitlements)
- Go `LocalSubnets()` + `ScanSubnet(cidr, ports, timeoutMs)` find open hosts on the phone's /24 network.
- JS fingerprints each candidate with a cheap HTTP request (e.g. `GET /api/version` → Frigate, `/ISAPI/System/deviceInfo` → Hikvision, `/cgi-bin/api.cgi` → Reolink, `/api/auth/login` → UniFi OS).
- Multicast discovery (ONVIF WS-Discovery) needs Apple's multicast entitlement, so it's out for now.

## 4. Sightline Hub (`bridge/` evolves into this)

### API (v1), all routes under `/v1`, `Authorization: Bearer <token>`

| Route | Purpose |
|---|---|
| `GET /info` | Hub name, version, systems, remote URL, the caller's grant |
| `GET /cameras` | `[{id, name, ptz, aspect}]`, filtered by grant |
| `GET /cameras/{id}/snapshot.jpg?height=` | Snapshot |
| `GET /cameras/{id}/live` | WebSocket, go2rtc MSE protocol |
| `GET /events?cameras=&after=&before=&limit=` | Normalized events, clamped to the grant window |
| `GET /events/{id}/thumbnail.jpg` | Event thumbnail |
| `GET /recordings/{cam}/segments?after=&before=` | Recording spans |
| `GET /recordings/{cam}/vod.m3u8?start=&end=` | VOD (`vod` kind) |
| `GET /recordings/{cam}/clip.mp4?start=&end=` | Clip export |
| `POST /cameras/{id}/ptz {action}` | PTZ |
| `PUT /devices/{id}` | Push registration and alert rules (the existing bridge API, moved) |
| `POST /grants`, `GET /grants`, `DELETE /grants/{id}` | Sharing (owner only) |
| `POST /pair {code}` | First owner pairing; returns the owner token |

### Grants
```
{ id, name, role: full|household|temporary|live,
  cameras: string[] | "all",
  recordings: "all" | "none" | {from, to},
  expiresAt: number | null }
```
The Hub enforces grants on **every** route:
- Cameras outside the grant return 404.
- Time windows clamp event and recording queries; a VOD or clip outside the window returns 403.
- Expired tokens return 401.
- Live-only grants can't reach recordings.

### Backends (Go), one per brand, behind a single interface
`Frigate` (MQTT plus internal API), `Hikvision` (ISAPI alertStream, RTSP playback), `Dahua` (eventManager, RTSP playback), `Reolink` (HTTP API), `UniFi Protect` (bootstrap plus websocket), `ONVIF` (pull-point events), generic RTSP. Live always goes through the Hub's embedded go2rtc.

### Remote
- tsnet + Funnel give a public `https://<hub>.<tailnet>.ts.net`. TLS ends on the Hub, never at Tailscale.
- One-time Tailscale sign-in is done from the Hub's setup page, never in a terminal.

### Setup without a terminal
1. Install the Hub: Home Assistant add-on, Synology/Unraid template, or Pi image.
2. Open its setup page (the app finds it on the network) and pick the cameras/NVR to wrap. The Hub reuses discovery.
3. Tap "Enable remote access" and sign in to Tailscale.
4. The app scans the Hub's QR code. Done.

## 5. Sharing (app)
- **Share access:** pick a type (Full / Household / Temporary / Live only), cameras and dates. The app gets an invite (QR plus link) containing the Hub URL and a one-time code.
- **The guest installs Sightline and scans it.** Their app adds a `hub` system with the guest token. No passwords, no VPN.
- **Shared access screen:** lists people, revoke, and optionally notify when a guest views a camera.

## 6. Feature backlog tied to the generic event pipeline
- Doorbell call screen: a `doorbell` event or label opens a full-screen "Someone's at the door".
- Packages: "delivered" / "picked up" from `package` objects.
- Daily timelapse via `clip` + playback speed, or a Frigate export with timelapse.
