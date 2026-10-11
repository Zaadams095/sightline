# Sightline Hub (formerly sightline-bridge)

The Hub is a small always-on service that connects the Sightline app to your camera system. It gives you:

- **One API for any brand.** The app talks to the Hub the same way whatever is behind it (see [docs/HUB_API.md](../docs/HUB_API.md)). Each brand is a small package under `backend/` that registers itself, so the setup page lists every brand this Hub knows and asks only for what that brand needs (usually the address, username and password). Adding a brand is described in `backend/todo.go`.
- **Instant Alerts.** It listens to each system's event stream (for example Frigate's MQTT), applies each phone's alert rules, and sends a push through the free Expo Push Service. The words and a tiny thumbnail are end-to-end encrypted for each phone (`seal.go`, `thumb.go`), so Expo, Apple and Google only see "Activity on your cameras".
- **Sharing.** Full, Household, Temporary and Live-only access, enforced by the Hub on every request.
- **Remote access** without port forwarding: one Tailscale sign-in from the setup page, then a public `https://<hub>.<tailnet>.ts.net` link (Tailscale Funnel). TLS ends on the Hub.
- **A setup page** at `http://<hub-address>:8086`. It has a pairing QR code, camera systems, remote access and who has access. No terminal or config files needed.

Video only leaves your network to go to phones you've paired or shared with. There's no Sightline cloud.

## Install

### Home Assistant (easiest)

Add `https://github.com/Zaadams095/sightline` under **Settings → Add-ons → Add-on Store → ⋮ → Repositories**. Install **Sightline Hub**, start it, and open its Web UI. See [homeassistant/sightline_hub/DOCS.md](../homeassistant/sightline_hub/DOCS.md).

### Docker Compose

```yaml
services:
  sightline-hub:
    image: ghcr.io/zaadams095/sightline-hub:latest
    container_name: sightline-hub
    restart: unless-stopped
    ports:
      - "8086:8086"
    environment:
      TZ: America/Denver
      # Optional, Frigate on the same compose network only (otherwise add it on the setup page):
      # FRIGATE_URL: http://frigate:5000
      # MQTT_URL: tcp://mqtt:1883
    volumes:
      - ./sightline-hub:/data
```

Then open `http://<this computer's IP>:8086` on any device on your network, tap **Add a camera system**, pick your brand and type its address, username and password.

Existing `sightline-bridge` installs keep working unchanged. It's the same image, and `BRIDGE_SECRET` still enables the original `/devices` API. To get the Hub features, open the setup page on port 8086.

### Unraid

**Docker → Add Container**:
- **Repository:** `ghcr.io/zaadams095/sightline-hub:latest`
- **Network type:** `bridge`
- **Port:** container `8086` → host `8086`
- **Path:** container `/data` → host `/mnt/user/appdata/sightline-hub`
- **Variables:** none needed. Add your camera system on the setup page. (For Frigate you can optionally set `FRIGATE_URL` = `http://<unraid-ip>:5000` and `MQTT_URL` = `tcp://<unraid-ip>:1883`.)

Then open the WebUI at `http://<unraid-ip>:8086`.

### Synology (Container Manager)

**Registry → search `ghcr.io/zaadams095/sightline-hub`**. Alternatively, create a **Project** with the compose file above.
- Map local port `8086` to container port `8086`.
- Map the folder `docker/sightline-hub` to `/data`.
- No variables are needed; add your camera system on the setup page (or set `FRIGATE_URL` if Frigate runs on the NAS).

Then open `http://<nas-ip>:8086`.

## Settings (environment)

All settings are optional; the setup page covers the normal path.

| Variable | Default | |
|---|---|---|
| `FRIGATE_URL` | (none) | Frigate's internal API, e.g. `http://frigate:5000`. Use `none` to skip. |
| `MQTT_URL` | `tcp://mqtt:1883` when `FRIGATE_URL` is set | Broker for Instant Alerts |
| `MQTT_USER` / `MQTT_PASSWORD` | | |
| `FRIGATE_TOPIC_PREFIX` | `frigate` | |
| `HUB_NAME` | `Home` | Shown in the app and invites (also editable on the page) |
| `HUB_URL` | auto | LAN address put in the pairing QR code, if auto-detection picks the wrong one (e.g. Docker bridge networks): `http://192.168.1.20:8086` |
| `REMOTE_ACCESS` | `on` | `off` hides remote access |
| `TS_HOSTNAME` | `sightline-hub` | Tailscale machine name, and so the public URL |
| `TS_AUTHKEY` | | Advanced: join Tailscale with an auth key instead of the sign-in link |
| `SETUP_PASSWORD` | | Protect the setup page with a password (any username) |
| `SETUP_HOSTS` | | Extra host names allowed to open the setup page (comma-separated) |
| `BRIDGE_SECRET` | | Legacy: enables the original bridge API for the app's old Instant Alerts screen |
| `EXPO_ACCESS_TOKEN` | | Only if enhanced push security is on for the Expo project |
| `DATA_DIR` | `/data` | `devices.json`, `grants.json`, `settings.json`, `tailscale/` |
| `LISTEN` | `:8086` | |
| `LIVE_GRACE` | `60` | Seconds a camera's live stream stays connected after the last viewer leaves, so reopening it is instant. `0` turns this off. |
| `LOG_LEVEL` | | `debug` logs each live view's startup timing |

## Security model

- **Tokens.** Every phone gets its own random 32-byte token. Owners get theirs by pairing with the 6-digit code; guests get theirs by redeeming a one-time invite code. Only SHA-256 hashes are stored. Revoking takes effect on the next request.
- **Pairing.** Pairing happens only on the home network, never over the public link. The first code lasts until it's used. Once a phone is paired, a new code can only be made within 15 minutes of a Hub restart, which proves you control the box. Wrong codes are rate-limited per address and globally.
- **Setup page.** It's served on the home network only, and only for IP addresses and local names, which blocks DNS rebinding. Cross-site form posts are refused. Under Home Assistant it sits behind HA's login (ingress). `SETUP_PASSWORD` adds a password elsewhere.
- **Public link.** It serves only `/v1` and the invite landing page. TLS terminates in the Hub's embedded Tailscale node.

## Build and test

    go vet ./... && go test ./...
    go build -tags notsnet .   # optional: ~17 MB binary without remote access (vs ~44 MB)
    docker build -t sightline-hub .

## Design note: Raspberry Pi image (not built yet)

The goal is a Pi image for people with no Home Assistant, NAS or Docker. You flash the card, plug the Pi in, scan the code.

- **Base:** Raspberry Pi OS Lite (arm64), built with `pi-gen` in CI as a custom stage. Only `sightline-hub`, `go2rtc` (for recording plain RTSP cameras later), and `avahi-daemon` are added.
- **Service:** the static `sightline-hub` binary runs under systemd as an unprivileged user with `DATA_DIR=/var/lib/sightline-hub`. Unattended security upgrades stay on.
- **Discovery:** advertise `_sightline._tcp` plus `http://sightline-hub.local:8086` over mDNS. The app's "Find my cameras" already probes `/v1/info` on port 8086.
- **First boot:** no Wi-Fi credentials are baked in. Use Ethernet, or the Raspberry Pi Imager's Wi-Fi settings. A captive-portal Wi-Fi setup AP is a stretch goal.
- **Updates:** an A/B partition scheme (e.g. RAUC or mender) is too heavy for v1. Instead, the Hub checks GitHub Releases for a signed binary, and the setup page gets an "Update now" button. The previous binary is kept for rollback.
- **Recording:** a later Hub version can record RTSP cameras itself, so a Pi plus IP cameras makes a complete system. That needs a USB SSD; SD cards wear out.
