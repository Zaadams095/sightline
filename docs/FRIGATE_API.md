# Frigate API notes (verified against v0.18.0 source)

Paths are relative to github.com/blakeblackshear/frigate at tag `v0.18.0`.

## Auth (port 8971)
- `POST /api/login` with `{"user","password"}` returns 200 and the JWT **only** in the `Set-Cookie: frigate_token=…` header (the cookie name is configurable). 401 means bad credentials; 404 means auth is disabled; logins are rate-limited.
- `Authorization: Bearer <jwt>` is accepted, but a Bearer token is **never refreshed**, so log in again before `exp`. The default session length is 24 h.
- Every non-GET request carrying an `Origin` header also needs `X-CSRF-TOKEN`. The gateway strips Origin and always sends `X-CSRF-TOKEN: 1`.
- TLS on 8971 is a self-signed cert by default.
- Port 5000 is unauthenticated (admin).

## Config
- `GET /api/config` returns `cameras.<name>` with:
  - `enabled`, `friendly_name`, `ui.order`
  - `zones{}`, `objects.track[]`, `detect.width/height`
  - `onvif.host`: PTZ is available when this is non-empty
  - `live.streams{label: go2rtc_name}`: defaults to `{cam: cam}`

## Images
- `GET /api/<cam>/latest.webp?height=&quality=`. The parameter is `height`, not `h`.
- `GET /api/events/<id>/snapshot.jpg`, `GET /api/events/<id>/thumbnail.webp`
- Review thumbnail: `thumb_path` with `/media/frigate/` stripped, e.g. `/clips/review/thumb-….webp`

## Live
- 8971 has **no** HLS/MP4 for live.
- Available:
  - `/live/mse/api/ws?src=<stream>`: go2rtc MSE. Send `{"type":"mse","value":"<codecs>"}`; you receive binary fMP4.
  - `/live/webrtc/api/ws?src=`
- The app plays MSE in a WKWebView (ManagedMediaSource, iOS 17.1+) through the loopback gateway.

## Review
- `GET /api/review?cameras=&labels=&zones=&reviewed=&limit=&severity=&before=&after=`
  - Without `after`/`before`, it covers the last 24 h. Results are sorted by `start_time` descending.
  - Items: `{id, camera, start_time, end_time|null, severity, thumb_path, has_been_reviewed, data{objects, zones, sub_labels, detections}}`
- `POST /api/reviews/viewed` with `{"ids":[…], "reviewed":true}`
- `GET /api/review/<id>/preview?format=mp4`, `GET /api/review/<id>/clip.mp4`
- `GET /api/review/summary`

## Recordings
- VOD (fMP4 HLS, AVPlayer-compatible): `/vod/<cam>/start/<s>/end/<e>/master.m3u8`. Capped at 7200 s.
- `GET /api/<cam>/recordings?after=&before=`: **always pass both**, because the server's defaults are stale.
- `GET /api/<cam>/recordings/summary?timezone=`

## PTZ
- WebSocket only: connect to `/ws` and send `{"topic":"onConnect","message":"","retain":false}`, then `{"topic":"<cam>/ptz","payload":"MOVE_LEFT","retain":false}`.
- Payloads: `MOVE_UP|DOWN|LEFT|RIGHT`, `ZOOM_IN|OUT`, `FOCUS_IN|OUT`, `STOP`, `preset_<name>`.
- Moves are continuous; send `STOP` on release.
- `GET /api/<cam>/ptz/info` returns `{features:[pt,zoom,pt-r,…], presets:[…]}`, or `{}` if the camera has no PTZ.

## MQTT (Instant Alerts bridge)
- Topic `frigate/reviews` carries `{"type":"new"|"update"|"end","before":{…},"after":{…}}`. The item shape matches `/api/review`.
- `update` is sent when severity is upgraded, new objects appear, or a sub_label is added.

## Version
- `GET /api/version` returns plain text.
