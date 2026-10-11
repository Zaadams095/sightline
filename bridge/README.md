# sightline-bridge (Instant Alerts)

An optional companion container for Frigate. It subscribes to `frigate/reviews` over MQTT, applies each paired phone's notification rules, and sends a text-only push through the free Expo Push Service.

- No images or video leave your network.
- It needs outbound HTTPS to `exp.host` only.
- It never accepts connections from the internet. Its API on :8086 is used by the app over your LAN or VPN and requires `BRIDGE_SECRET`.

The app generates a ready-to-paste compose snippet under Settings → Instant Alerts.

## Environment

| Variable | Default | |
|---|---|---|
| `MQTT_URL` | `tcp://mqtt:1883` | The broker Frigate publishes to |
| `MQTT_USER` / `MQTT_PASSWORD` | | |
| `FRIGATE_TOPIC_PREFIX` | `frigate` | |
| `BRIDGE_SECRET` | (required) | Shown in the app |
| `EXPO_ACCESS_TOKEN` | | Optional, if enhanced push security is enabled on the Expo project |
| `DATA_DIR` | `/data` | Paired devices are stored in devices.json |

## Build

    docker build -t sightline-bridge .
