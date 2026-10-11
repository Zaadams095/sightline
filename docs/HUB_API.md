# Sightline Hub API v1

This is the brand-neutral API the app's `HubAdapter` (`app/src/systems/hub.ts`) uses. The implementation lives in `bridge/` (`api_v1.go`, `grants.go`, `live.go`, `vod.go`), and the behavior is pinned by `bridge/hub_test.go`. Background is in [PLATFORM.md](PLATFORM.md) §4–5.

- The base URL is the LAN address (`http://192.168.1.20:8086`) or the public Funnel URL (`https://sightline-hub.<tailnet>.ts.net`). It's the same API on both, except `/v1/pair`, which is LAN only.
- Authentication is `Authorization: Bearer <token>`. Routes used by players that can't set headers (WebSocket, images, HLS, MP4) also accept `?token=<token>`. Every route accepts it.
- Times are unix seconds (floats where sub-second precision exists).
- Errors look like `{"error": "<code>", "message": "<plain-language text>"}`:

| Status | `error` | When |
|---|---|---|
| 400 | `bad_request`, `invalid` | Malformed input |
| 401 | `unauthorized` | Missing or unknown token |
| 401 | `revoked` | The grant was revoked (kept for 30 days, then becomes `unauthorized`) |
| 401 | `expired` | The grant's `expiresAt` has passed |
| 401 | `bad_code`, `bad_invite` | Wrong pairing code, or an invite that's invalid or already used |
| 403 | `forbidden` | The role doesn't allow this route |
| 403 | `outside_window` | Media outside the grant's recordings window |
| 403 | `lan_only` | `/v1/pair` over the public link |
| 404 | `not_found` | Unknown camera or event, **or one outside the caller's grant** (never 403, so other cameras' existence isn't revealed) |
| 429 | `rate_limited` | Too many wrong pairing or invite codes |
| 501 | `unsupported` | The backend can't do this |
| 502 | `upstream` | The recorder failed |

## IDs

Camera and event IDs are the backend's native IDs for the first configured system. For any additional system they're prefixed with `<systemId>~`, as in `nvr~garage`. Treat them as opaque strings.

## Grants and roles

```json
{
  "id": "g_3f2a…",
  "name": "Pet sitter",
  "role": "full | household | temporary | live | owner",
  "cameras": "all" | ["front", "back"],
  "recordings": "all" | "none" | {"from": 1760000000, "to": 1760600000},
  "expiresAt": 1760600000 | null,
  "createdAt": 1760000000,
  "lastUsedAt": 1760001234,
  "devices": 1,
  "pendingInvite": false
}
```

| | owner | full | household | temporary | live |
|---|---|---|---|---|---|
| How it's created | pairing code | invite | invite | invite | invite |
| Cameras | all | all (forced) | chosen | chosen | chosen |
| Live + snapshots | ✓ | ✓ | ✓ | ✓ | ✓ |
| Events, thumbnails, recordings, clips | ✓ | ✓ | ✓ (window if set) | ✓ within window (default: creation → `expiresAt`) | ✗ 403 |
| PTZ | ✓ | ✓ | ✓ | ✗ 403 | ✗ 403 |
| Push alerts (`/v1/devices`) | ✓ | ✓ | ✓ | ✓ | ✗ 403 |
| Manage grants | ✓ | ✓ (cannot revoke owners) | ✗ 403 | ✗ 403 | ✗ 403 |
| `expiresAt` | never | optional | optional | **required** | optional |

**Decision:** `full` is owner-equivalent: it can share and revoke guest access. That's how you add another of your own phones or a partner. Only an owner can remove an owner.

### Enforcement on every route

- **Cameras outside the grant** return 404 on every camera, event and recording route, and are filtered out of lists. Asking `/v1/events?cameras=<not granted>` returns `[]`.
- **Window clamping.** `events` and `segments` queries are clamped to `recordings.from/to`. Events are kept only if they *start* inside the window. Segments are trimmed to it.
- **`vod.m3u8` and `clip.mp4`.** A request entirely outside the window returns 403. One that partly overlaps is clamped to the overlap. VOD media files (`/vod/{start}/{end}/{file}`) must lie entirely inside the window, which they do when they come from a Hub-issued playlist.
- **Live-only** grants get 403 on every recordings route.
- **Expired or revoked** grants get 401 on every route, including WebSockets and media. Revoking also unregisters the guest's phones from push. Alerts check the grant at send time, so an expired guest stops getting alerts immediately.

## Routes

### `GET /v1/info`
Without a token, this is the public part, used for discovery and the pairing screen:
```json
{"sightline": "hub", "name": "Home", "version": "0.3.0", "apiVersion": 1, "paired": true}
```
With a token, it adds:
```json
{
  "systems": [{"id": "frigate", "kind": "frigate", "label": "Frigate", "name": "Frigate"}],
  "lanUrl": "http://192.168.1.20:8086",
  "remoteUrl": "https://sightline-hub.tail1234.ts.net" | null,
  "capabilities": {"live": true, "snapshots": true, "events": true, "recordings": true, "clips": true, "ptz": true, "push": true, "sharing": true},
  "grant": { …grant… }
}
```
`capabilities` already reflect the caller's grant.

### `POST /v1/pair` (LAN only, rate-limited)
```json
→ {"code": "123456", "deviceName": "Zach's iPhone"}
← {"token": "slh_…", "grant": {…role "owner"…}, "hub": {"name": "Home", "lanUrl": "…", "remoteUrl": "…"}}
```
The setup page shows the 6-digit code, which is also in the logs. It's single-use.
- The first code is valid until used.
- Once someone is paired, a new code can only be made within 15 minutes of a Hub restart, and it lasts 15 minutes.
- Rate limits: 5 wrong codes per minute per address, and 20 per 10 minutes overall.

### `POST /v1/redeem` (rate-limited)
```json
→ {"code": "ABCDE-FGHJK"}
← {"token": "slh_…", "grant": {…}, "hub": {…}}
```
The code is case- and dash-insensitive and one-time. It expires after 7 days or at the grant's `expiresAt`, whichever comes first. Rate limits: 10 wrong codes per minute per address, and 60 per 10 minutes overall.

### `GET /v1/cameras`
```json
[{"id": "front", "name": "Front Door", "enabled": true, "ptz": false, "aspect": 1.777,
  "zones": ["porch"], "objects": ["person", "car"], "detectSize": {"width": 1280, "height": 720} | null,
  "system": "frigate"}]
```
`ptz` is false for roles that can't move cameras.

### `GET /v1/cameras/{id}/snapshot.jpg?height=`
Returns the current frame (JPEG).

### `GET /v1/cameras/{id}/live?quality=main|sub` (WebSocket)
This route uses go2rtc's MSE protocol:
1. The client sends `{"type":"mse","value":"<codecs the player supports>"}`.
2. The Hub replies `{"type":"mse","value":"<mime>"}`, then sends binary fMP4 fragments.
3. Errors arrive as `{"type":"error","value":"…"}`.

For Frigate, the Hub pipes Frigate's internal go2rtc (`/live/mse/api/ws?src=<stream>`). For RTSP sources, it restreams with go2rtc's `pkg/rtsp` and `pkg/mp4`.

### `GET /v1/cameras/{id}/ptz` / `POST /v1/cameras/{id}/ptz`
`GET` returns `{"canMove": true, "canZoom": false, "presets": ["door"]}`. `POST` takes `{"action": "MOVE_LEFT"}` and returns 204. The actions are `MOVE_UP|MOVE_DOWN|MOVE_LEFT|MOVE_RIGHT|ZOOM_IN|ZOOM_OUT|STOP|preset_<name>`. Moves continue until `STOP`.

### `GET /v1/events?cameras=a,b&after=&before=&severity=alert|detection&limit=100`
Newest first:
```json
[{"id": "1760000000.1-abc", "camera": "front", "start": 1760000000.1, "end": 1760000030.5 | null,
  "severity": "alert", "objects": ["person"], "subLabels": ["Zach"], "zones": ["porch"],
  "detections": ["1760000000.1-x"], "reviewed": false,
  "thumbnail": "/v1/events/1760000000.1-abc/thumbnail.jpg?token=…"}]
```
`thumbnail` is relative to the base URL. It carries `?token=` only when the request used one.

### `GET /v1/events/{id}/thumbnail.jpg`
The event's still image. It may be WebP; trust `Content-Type`.

### `GET /v1/recordings/{cam}/segments?after=&before=`
Returns `[{"start": 1760000000, "end": 1760000600}]`. Back-to-back files are merged (≤0.5 s gaps), and spans are clamped to the window.

### `GET /v1/recordings/{cam}/vod.m3u8?start=&end=`
Seekable HLS (fMP4) for the window, capped at 2 h, with gaps removed. Every URI in the playlist is rewritten to a relative Hub URL:
```
vod/<start>/<end>/index-v1.m3u8?token=…
```
That resolves to `GET /v1/recordings/{cam}/vod/{start}/{end}/{file}`. Each follow-up request is grant-checked again, and nested playlists are rewritten the same way. Only base file names (`[A-Za-z0-9_.-]`) pass through.

### `GET /v1/recordings/{cam}/clip.mp4?start=&end=`
MP4 export, streamed. `Range` is passed through.

### `PUT /v1/devices/{id}` · `DELETE /v1/devices/{id}` · `POST /v1/devices/{id}/test`
Push registration, same body as the original bridge (`app/src/alerts/bridge.ts`):
```json
{"pushToken": "ExponentPushToken[…]", "systemId": "<app system id>", "timezone": "America/Denver",
 "defaultRule": {"enabled": true, "objects": [], "zones": [], "severities": ["alert"]},
 "rules": {"<cameraId>": {…}}, "cameraNames": {"front": "Front Door"},
 "masks": {}, "detectSizes": {}, "quietHours": {"enabled": false, "start": "22:00", "end": "07:00"},
 "cooldownSec": 60, "quietFor": [], "snoozed": {}, "health": {"enabled": true, "storagePct": 90},
 "atHome": false, "alertWhenHome": [],
 "thumbKey": "<per-phone secret ≥16 chars>"}
```
- The device is bound to the caller's grant. Alerts and health notices only cover cameras the grant can see, and only while it's active. Storage and "system down" notices go only to owner, full and household.
- `thumbKey` encrypts the inline push thumbnail (AES-256-GCM, key `SHA256("sightline-thumb-v1:" + thumbKey)`).
- The iOS notification extension can also fetch a full frame from the legacy `GET /snapshot/{camera}` with `X-Bridge-Secret: <thumbKey>` (LAN only).
- Another grant's registration can't be overwritten or deleted (403), except by an owner.

### Grants: `GET /v1/grants`, `POST /v1/grants`, `DELETE /v1/grants/{id}`, `POST /v1/grants/{id}/invite`
These require an owner or full grant.

`GET` lists active grants, owners included.

`POST` creates a grant:
```json
→ {"name": "Pet sitter", "role": "temporary", "cameras": ["front", "back"],
   "recordings": {"from": 1760000000, "to": 1760600000}, "expiresAt": 1760600000}
← 201 {"grant": {…}, "invite": {"code": "ABCDE-FGHJK",
        "link": "sightline://invite?code=ABCDE-FGHJK&lan=…&name=Home&url=https%3A%2F%2F…",
        "webLink": "https://sightline-hub.tail1234.ts.net/invite?code=ABCDE-FGHJK",
        "expiresAt": 1760604800}}
```
- If omitted, `cameras` defaults to `"all"`. `recordings` defaults by role: full `all`, household `all`, temporary `{now, expiresAt}`, live `none`.
- The invite never contains a token.
- `webLink` (only when remote access is on) is a landing page with an "Open in Sightline" button, for people who don't have the app yet.

`POST /{id}/invite` issues a fresh code for the same grant (e.g. the guest's second phone).

`DELETE` revokes immediately (204). A `full` caller can't revoke owners (403).

## Deep links

The app handles these links, whether scanned as a QR code or tapped:

| Link | Meaning |
|---|---|
| `sightline://hub?url=<lan url>&code=<6 digits>&name=<hub>[&remote=<funnel url>]` | Owner pairing (QR on the setup page) |
| `sightline://invite?url=<preferred url>&code=<invite code>&name=<hub>[&lan=…][&remote=…]` | Guest invite. `url` is the public URL when remote access is on. |

## Not in v1 (yet)

Marking events reviewed, smart search, motion activity, recording-day summaries, camera groups, two-way audio, and a "notify me when a guest watches" audit log.
