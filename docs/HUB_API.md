# Sightline Hub API v1

This is the brand-neutral API the app's `HubAdapter` (`app/src/systems/hub.ts`) uses. The implementation lives in `bridge/` (`api_v1.go`, `grants.go`, `live.go`, `vod.go`, `playback.go`), and the behavior is pinned by `bridge/hub_test.go` and `bridge/playback_test.go`. Brands plug in behind it through `bridge/backend` (see `backend/todo.go`). Background is in [PLATFORM.md](PLATFORM.md) §4–5.

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
| Talk, spotlight and siren | ✓ | ✓ | ✓ | ✗ 403 | ✗ 403 |
| Push alerts (`/v1/devices`) | ✓ | ✓ | ✓ | ✓ | ✗ 403 |
| Manage grants | ✓ | ✓ (cannot revoke owners) | ✗ 403 | ✗ 403 | ✗ 403 |
| `expiresAt` | never | optional | optional | **required** | optional |

**Decision:** `full` is owner-equivalent: it can share and revoke guest access. That's how you add another of your own phones or a partner. Only an owner can remove an owner.

**Decision:** talking through a camera and its spotlight/siren follow PTZ: they are for the people who live there (owner, full, household). Temporary and live-only guests (a pet sitter, a neighbor) can watch, but they never speak, flash lights or sound a siren in the owner's name. Their `/v1/info` reports `talk: false` and `deter: false`, and the routes answer 403.

### Enforcement on every route

- **Cameras outside the grant** return 404 on every camera, event and recording route, and are filtered out of lists. Asking `/v1/events?cameras=<not granted>` returns `[]`.
- **Window clamping.** `events` and `segments` queries are clamped to `recordings.from/to`. Events are kept only if they *start* inside the window. Segments are trimmed to it.
- **`playback`, `vod.m3u8` and `clip.mp4`.** A request entirely outside the window returns 403. One that partly overlaps is clamped to the overlap. VOD media files (`/vod/{start}/{end}/{file}`) and playback media (`/playback/stream`, `/playback/file.mp4`) must lie entirely inside the window, which they do when they come from a Hub-issued URL.
- **Replays and recorder files.** Replay streams are cut off at the window's end even if the recorder keeps sending. A recorder file that may begin before or end after a time-limited guest's window is never handed out: the Hub exports exactly the window as `clip.mp4` instead (or answers 403 if the system can't export).
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
  "systems": [{"id": "frigate", "kind": "frigate", "label": "Frigate", "name": "Frigate",
               "capabilities": {…same keys as below, for this system only…}}],
  "lanUrl": "http://192.168.1.20:8086",
  "remoteUrl": "https://sightline-hub.tail1234.ts.net" | null,
  "capabilities": {"live": true, "snapshots": true, "events": true, "recordings": true, "clips": true, "ptz": true, "alerts": true, "push": true, "sharing": true, "talk": true, "deter": true},
  "grant": { …grant… }
}
```
`capabilities` combine what the systems can do (each backend reports its own features; top level = at least one system can) with what the caller's grant allows. A brand without an event API reports `events: false`, one without recordings `recordings: false`, and so on; the app hides those features instead of assuming Frigate's. `alerts` means Instant Alerts can be delivered (a system has an event stream); `push` means the grant may register for them. `talk` and `deter` mean some camera may have a speaker or a spotlight/siren (ask each camera, below). Routes for a feature a system lacks answer 501 `unsupported`.

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

For Frigate, the Hub pipes Frigate's internal go2rtc (`/live/mse/api/ws?src=<stream>`). For RTSP sources (NVRs and cameras of every other brand), it restreams with go2rtc's `pkg/rtsp` and `pkg/mp4`.

### `GET /v1/cameras/{id}/live.m3u8?quality=main|sub` (HLS)
Live view for players without Media Source Extensions (the Apple TV app uses it with AVPlayer). It returns a master playlist and starts a short-lived session for this caller:
```
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2000000,CODECS="avc1.640029,mp4a.40.2"
hls/<session>/playlist.m3u8?token=…
```
The session's files are `/v1/cameras/{id}/hls/<session>/playlist.m3u8`, `init.mp4` and `s<n>.m4s` (fMP4). Every request is grant-checked like the other camera routes, and a session only answers the grant and camera that started it. It ends about 10 seconds after the player stops asking. The source is the same fMP4 stream as the WebSocket route, so this works for every brand. Video is H.264/H.265 with AAC audio. At most 16 sessions run at once; beyond that the Hub answers 503 `busy`. If the camera can't be reached it answers 502 `upstream`.

### `GET /v1/cameras/{id}/ptz` / `POST /v1/cameras/{id}/ptz`
`GET` returns `{"canMove": true, "canZoom": false, "presets": ["door"]}`. `POST` takes `{"action": "MOVE_LEFT"}` and returns 204. The actions are `MOVE_UP|MOVE_DOWN|MOVE_LEFT|MOVE_RIGHT|ZOOM_IN|ZOOM_OUT|STOP|preset_<name>`. Moves continue until `STOP`.

### `GET /v1/cameras/{id}/talk` (owner, full, household)
Two-way audio: the caller's voice out of the camera's speaker.
- **Without a WebSocket upgrade** it says whether this camera can take audio: `{"available": true, "codec": "PCMU/8000"}`. The Hub asks the camera itself (an RTSP `DESCRIBE` with the ONVIF backchannel header, or Hikvision's `/ISAPI/System/TwoWayAudio/channels`) and remembers the answer (30 minutes for yes, 2 for no). The app shows its Talk button only when `available` is true. 501 when the system has no way to talk at all.
- **With a WebSocket upgrade** it is the talk session:
  1. The Hub opens the speaker and sends `{"type":"talk","value":"PCMA/8000"}`, or `{"type":"error","value":"<plain-language reason>"}` and closes.
  2. The app sends binary frames of **16-bit little-endian mono PCM at 8000 Hz** (any length; ~20–100 ms per frame is typical). The Hub encodes them for the camera (G.711 A-law/µ-law, or linear PCM at the camera's rate), cuts 20 ms RTP packets and sends them on the backchannel.
  3. Closing the socket hangs up. Only the audio direction is opened (no video comes back).

Brands: the ONVIF RTSP backchannel for Dahua/Amcrest/Lorex (`proto=Onvif` stream), ONVIF cameras, plain RTSP links, Reolink models that offer it (doorbells) and Frigate (through its go2rtc RTSP server on port 8554, for cameras with a go2rtc stream). Hikvision uses ISAPI two-way audio, for a camera on its own over `http://` only (a recorder's two-way audio is the recorder's own audio out). UniFi Protect isn't supported (its talkback needs a separate per-camera stream setup). The app's tunnel library speaks the same protocol for systems it reaches directly (`tunnel/wgtunnel/talk.go`); the shared encoder is `backend/talk`.

### `GET /v1/cameras/{id}/deter` / `POST /v1/cameras/{id}/deter` (owner, full, household)
`GET` returns what the camera has, from the device's own capability flags:
```json
{"light": true, "siren": true, "lightAutoOffSec": 0, "sirenSec": 10}
```
`lightAutoOffSec` is how long the spotlight stays on by itself (0 or absent: until turned off). `sirenSec` is roughly how long one siren lasts (it always stops by itself). `POST` takes `{"action": "light-on" | "light-off" | "siren"}` and returns 204; 501 when the camera lacks that output, 400 for an unknown action.

Brands: Reolink (`SetWhiteLed`, `AudioAlarmPlay` once; from `floodLight`/`supportFLswitch` and `alarmAudio`/`supportAudioAlarm` abilities), Dahua/Amcrest active-deterrence cameras (`coaxialControlIO.cgi`, from its `getStatus`). Not offered: Hikvision (no documented manual trigger for the strobe or audible warning; its alarm outputs are wired relays, not a siren), UniFi Protect (lights and sirens are separate devices), Frigate and the rest.

### `GET /v1/events?cameras=a,b&after=&before=&severity=alert|detection&limit=100`
Newest first:
```json
[{"id": "1760000000.1-abc", "camera": "front", "start": 1760000000.1, "end": 1760000030.5 | null,
  "severity": "alert", "objects": ["person"], "subLabels": ["Zach"], "zones": ["porch"],
  "detections": ["1760000000.1-x"], "reviewed": false,
  "thumbnail": "/v1/events/1760000000.1-abc/thumbnail.jpg?token=…"}]
```
`thumbnail` is relative to the base URL. It carries `?token=` only when the request used one.

### `GET /v1/rings?after=&wait=`
Doorbell rings as they happen, for screens that switch to the doorbell (the Apple TV tour). A long poll: it answers at once when there are rings newer than `after`, otherwise waits up to `wait` seconds (at most 25) for one.
```json
{"rings": [{"id": "1760000000.1-abc", "camera": "front", "at": 1760000003.2, "start": 1760000000.1}], "now": 1760000003.4}
```
`at` is when the Hub heard about the ring, by the Hub's clock; pass the reply's `now` back as `after` (a first call with `wait=0` gets a starting `now`). `start` is the recorder's own time. Any grant may ask, live-only ones included, because a ring is "happening now" like live video: only the last two minutes are kept, only on the caller's cameras, with no thumbnails or history. Rings come from systems with a live event stream (the same ones that power Instant Alerts).

### `GET /v1/events/{id}/thumbnail.jpg`
The event's still image. It may be WebP; trust `Content-Type`.

### `GET /v1/recordings/{cam}/segments?after=&before=`
Returns `[{"start": 1760000000, "end": 1760000600}]`. Back-to-back files are merged (≤0.5 s gaps), and spans are clamped to the window.

### `GET /v1/recordings/{cam}/playback?start=&end=`
How to play a recorded window (unix seconds, capped at 2 h, clamped to the grant). Recorders differ: some serve seekable HLS, most NVRs only replay as a live-style stream from a start time, and others hand out whole MP4 files. The app calls this first and plays whatever it says. URLs are relative to the base URL and carry `?token=` only when the request used one.
```json
{"kind": "vod", "url": "/v1/recordings/front/vod.m3u8?start=S&end=E", "start": S, "end": E}

{"kind": "stream", "source": {"kind": "mse", "url": "/v1/recordings/front/playback/stream?start=S&end=E"},
 "start": S, "end": E, "startTime": 1760000012}

{"kind": "stream", "source": {"kind": "file", "url": "/v1/recordings/front/playback/file.mp4?start=S&end=E", "startTime": 1759999800},
 "start": S, "end": E}
```
- `vod`: seekable HLS, exactly as `vod.m3u8` below (Frigate and any backend with HLS VOD).
- `stream` + `mse`: a WebSocket speaking the same MSE protocol as live view (`/live`). It plays forward from `start`; to seek, ask for a new window. `startTime` (optional) is when the first frame really is, if the recorder's nearest recording starts later.
- `stream` + `file`: an MP4 (`Range` supported). `source.startTime` (optional) is when the file begins if earlier than `start`: seek to `start − startTime`.

Backends choose by implementing `backend.Player` (RTSP replay or MP4 files) or `VOD` (HLS). 501 when the system has no recordings.

### `GET /v1/recordings/{cam}/playback/stream?start=&end=` (WebSocket) · `GET /v1/recordings/{cam}/playback/file.mp4?start=&end=`
The media behind a `stream` answer. Only use URLs returned by `playback`.

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
- `zones` (newer apps): activity zones per camera ID, `[{"id", "name", "mode": "include"|"exclude", "points": [{"x","y"}…], "objects": ["person"|"vehicle"|"animal"|"package"]}]`, points normalized 0..1 from the top-left. Include = "only alert about things here", exclude = "ignore things here"; `objects` empty = anything. Applied to object foot positions (systems that report them; today Frigate), normalized with `detectSizes`; events without positions are never suppressed, and doorbell rings skip zones. When `zones` is present it replaces `masks`; older phones send only `masks` (polygons treated as exclude zones), and newer phones still send their plain exclude zones as `masks` for older Hubs.
- The device is bound to the caller's grant. Alerts and health notices only cover cameras the grant can see, and only while it's active. Storage and "system down" notices go only to owner, full and household.
- `thumbKey` encrypts the inline push thumbnail (AES-256-GCM, key `SHA256("sightline-thumb-v1:" + thumbKey)`).
- The iOS notification extension can also fetch a full frame from the legacy `GET /snapshot/{camera}` with `X-Bridge-Secret: <thumbKey>` (LAN only).
- Another grant's registration can't be overwritten or deleted (403), except by an owner.
- Optional `learning` ("fewer false alarms that learn", `bridge/learning.go`, mirrors `app/src/alerts/learning.ts`):
  `{"feedback": [{"id": "<event>", "at": 1760000000, "verdict": "not-important"|"important", "camera": "driveway", "objects": ["car"], "zones": [], "subLabels": [], "severity": "detection", "hour": "evening", "light": "night", "duration": "short"}], "confirmed": ["driveway|person|night"], "conditions": true, "sun": {"lat": 39.7, "lon": -105.0}}`.
  The Hub derives the same learned rules as the app and quiets matching alerts (never doorbell rings; person rules only when listed in `confirmed`). `conditions` turns on the rain/wind/headlights check for motion-only events, which holds such events for 10 s before deciding. `sun` is rounded to ~10 km and only used for sunrise/sunset.
- Optional `checkins` (family check-ins, `bridge/checkins.go`, mirrors `app/src/alerts/checkins.ts`): `[{"id", "enabled", "who": "Mom", "cameras": ["kitchen"], "zones": {}, "peopleOnly": false, "byTime": "10:00", "quietLimitHours": 6, "dayStart": "08:00", "dayEnd": "21:00", "summaryTime": "20:00", "timezone": "America/Chicago", "duringQuietHours": true, "cameraNames": {}}]`. Only cameras the grant can see count. State lives in `checkins.json`, survives restarts (gaps are filled from the recorder's events), and the Hub asks the recorder again before any "no activity" notice. Pushes use category `checkin-<id>`.
- `GET /v1/devices/{id}/checkins` → today's state per check-in (`firstToday`, `momentsToday`, `lastActivity`, `lastCamera`, …). `POST /v1/devices/{id}/checkins/{cid}/ok` → "Mom's fine" (quiets no-activity notices for the rest of the day and restarts the quiet-spell clock). Legacy: `POST /devices/{id}/checkins/{cid}/ok` with `X-Bridge-Secret`.
- `GET /v1/info` includes `timezone` (the Hub's IANA zone, from `TZ`) when known; check-in times default to it.

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
        "expiresAt": 1760604800, "qr": "data:image/png;base64,…"}}
```
`qr` is a PNG of `link`, so the app can show it without bundling a QR library.
- If omitted, `cameras` defaults to `"all"`. `recordings` defaults by role: full `all`, household `all`, temporary `{now, expiresAt}`, live `none`.
- The invite never contains a token.
- `webLink` (only when remote access is on) is a landing page with an "Open in Sightline" button, for people who don't have the app yet.

`POST /{id}/invite` issues a fresh code for the same grant (e.g. the guest's second phone).

`DELETE` revokes immediately (204). A `full` caller can't revoke owners (403).

### `GET /v1/diagnostics` (owner only)

Recent backend errors (in memory, newest 100, repeats folded) so the owner's app can attach them
to a problem report the user chooses to send (docs/CRASH_REPORTS.md). Everything is scrubbed when
recorded: no addresses, host names, usernames, passwords, tokens, emails or system names.

```json
{
  "version": "0.3.0",
  "uptime": 86400,
  "systems": [{ "brand": "hikvision", "connected": false }],
  "errors": [{ "time": 1790000000, "brand": "hikvision", "area": "snapshot", "category": "auth-401",
               "detail": "the username or password is wrong", "count": 3 }]
}
```

`area` is the feature (`cameras`, `live`, `snapshot`, `ptz`, `events`, `alerts`, `recordings`,
`clips`, `playback`); `category` is one of `auth`, `auth-401`, `auth-403`, `http-<status>`,
`timeout`, `dns`, `refused`, `unreachable`, `reset`, `tls`, `bad-reply`, `other`. Other roles get 403.

## Deep links

The app handles these links, whether scanned as a QR code or tapped:

| Link | Meaning |
|---|---|
| `sightline://hub?url=<lan url>&code=<6 digits>&name=<hub>[&remote=<funnel url>]` | Owner pairing (QR on the setup page) |
| `sightline://invite?url=<preferred url>&code=<invite code>&name=<hub>[&lan=…][&remote=…]` | Guest invite. `url` is the public URL when remote access is on. |

## Not in v1 (yet)

Marking events reviewed, smart search, motion activity, recording-day summaries, camera groups, two-way audio, and a "notify me when a guest watches" audit log.
