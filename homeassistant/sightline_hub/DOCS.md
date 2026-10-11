# Sightline Hub

The Sightline Hub connects the Sightline iPhone app to your cameras. It gives you:

- **Instant alerts** the moment a camera sees someone, with a picture.
- **Sharing**: give family, a neighbor or a pet sitter access to the cameras you choose, for as long as you choose. You can take it back at any time.
- **Watching away from home** without changing router settings.

Your video stays in your home. It only ever goes to phones you've paired or shared with.

## Setting it up

1. Install this add-on and press **Start**.
2. Press **Open Web UI** (or click **Sightline** in the sidebar).
3. On your iPhone, open **Sightline**, tap **I have a Sightline Hub**, and scan the code on the page.

That's it. Your cameras appear in the app.

### Watching away from home

On the setup page, press **Enable remote access** and sign in to Tailscale (free; you can use your Google, Microsoft or Apple account). If the page asks for one more step, press **Allow a public link** and approve it. Your phone then switches to the Hub's private link automatically whenever you leave home.

### Sharing with someone

In the Sightline app: **Settings → Sharing → Share access**. Choose what they can see and for how long, then send them the invite. They install Sightline and tap the link (or scan the QR code). To stop sharing, tap **Revoke**. It takes effect immediately.

## Options

You usually don't need to change anything.

| Option | What it does |
|---|---|
| `frigate_url` | Where Frigate is. The default works with the official Frigate add-on. For Frigate on another computer, use `http://<its address>:5000`. You can also add Frigate on the setup page instead. |
| `mqtt_url`, `mqtt_user`, `mqtt_password` | Only if you don't use the Mosquitto add-on. With Mosquitto, the Hub finds it on its own. |
| `hub_name` | The name shown in the app and in invites. |
| `remote_access` | Turn off to hide the remote access option completely. |

If you use the Frigate add-on **Full Access** or **Beta** version, its address is different. Find the hostname on the Frigate add-on's info page, then use `http://<hostname>:5000`.

## Troubleshooting

- **The setup page says it can't reach Frigate.** Check `frigate_url`. Port 5000 is Frigate's internal port. It has no login, so the Hub uses it from inside Home Assistant only.
- **No alerts.** Instant alerts need MQTT turned on in Frigate (`mqtt: enabled: true`) and the Mosquitto add-on running.
- **Lost your phone?** Restart this add-on, then open the setup page within 15 minutes. It shows a new pairing code. Remove the old phone under **Who has access**.
