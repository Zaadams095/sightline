# Camera guides

Guided setup for the cameras most people already own. Each brand is a data entry in
`app/src/systems/guides.ts` (steps, where it lands, field defaults, stream-link template, which
ports to look for). The screens (`onboarding/brands.tsx`, `onboarding/guide.tsx`,
`onboarding/find-brand.tsx`) never special-case a brand. URL building and the data's shape are
unit-tested in `app/test/guides.test.ts`.

Researched October 2026. Camera makers change their apps and firmware often. When a guide
is unsure about a model, the copy says "most models" and the brand screen always offers the
generic paths (Other network camera / Find cameras on my Wi-Fi / stream link).

## How a guide ends

| Target | What happens |
| --- | --- |
| `stream` | The user types (or scans for, or pastes) the address plus the camera account they just made. Sightline builds `rtsp://user:pass@host:port/path` from the template (user and password percent-encoded), tests that the port answers, and saves it as a stream camera. |
| `system` | Hands over to `onboarding/connect` for an existing adapter (Dahua, Hikvision, Reolink, UniFi Protect, ONVIF) with the brand name and usual username prefilled. Discovery is filtered to that adapter's fingerprints. |
| `unsupported` | A kind explanation and at least one way forward (another brand, a hub/recorder that does work, network scan, stream link). Never a dead end. A test enforces this. |

## Brands

| Brand | Path in Sightline | Template / adapter | Scan |
| --- | --- | --- | --- |
| TP-Link Tapo (plug-in) | stream | `rtsp://{auth}{host}:554/stream1` | 554 **and** 2020 |
| Tapo battery / doorbell | unsupported | — | — |
| Wyze Cam v3, Pan v3 | stream (paste link or build) | `rtsp://{auth}{host}:554/stream0` | 554 |
| Wyze v4, OG, doorbells, battery | unsupported | — | — |
| eufy (with "NAS (RTSP)") | stream (paste link or build) | `rtsp://{auth}{host}:554/live0` | 554 |
| eufy without it | unsupported | — | — |
| Imou | stream, user `admin`, password = safety code | `rtsp://{auth}{host}:554/cam/realmonitor?channel=1&subtype=0` | 554 |
| EZVIZ | stream, user `admin`, password = verification code | `rtsp://{auth}{host}:554/h264/ch1/main/av_stream` | 554 |
| Kasa | unsupported (points to Tapo) | — | — |
| Reolink plug-in / NVR / Home Hub | Reolink adapter | `reolink` | fingerprints |
| Reolink battery (alone), 4G | unsupported (points to Home Hub) | — | — |
| Amcrest | Dahua adapter | `dahua` | fingerprints |
| Lorex recorder | Dahua adapter | `dahua` | fingerprints |
| Lorex Wi-Fi / battery without recorder | unsupported | — | — |
| Swann recorder | ONVIF adapter ("most models") | `onvif` | fingerprints |
| Swann Wi-Fi / battery | unsupported | — | — |
| Annke | Hikvision adapter | `hikvision` | fingerprints |
| Hikvision (also HiWatch, LTS) | Hikvision adapter | `hikvision` | fingerprints |
| Dahua | Dahua adapter | `dahua` | fingerprints |
| Ubiquiti UniFi | UniFi Protect adapter | `unifi-protect` | fingerprints |
| Ring, Google Nest, Arlo, Blink, SimpliSafe | unsupported | — | — |

## Notes and caveats per brand

### TP-Link Tapo
- Needs a **Camera Account** (Tapo app → camera → gear → Advanced Settings → Camera Account),
  6–32 characters, separate from the Tapo login. Streams: `stream1` (high), `stream2` (low).
  RTSP port 554, ONVIF port 2020; the guide's scan looks for both to tell Tapo cameras apart.
- Tapo Care, microSD recording and NVR/ONVIF use: only two of the three at once.
- Battery models (C400/C420/C425, battery doorbells) generally can't give a continuous
  third-party stream. Some hardwired doorbells (D225/D235/TD25) can, only when wired and in
  always-on mode; not guided yet, they can use the plug-in path.
- The 2025+ "Third-Party Compatibility" switch (Me → Third-Party Services) affects Tapo's
  local control API, not RTSP; not needed here.
- Could later use the ONVIF adapter on port 2020 (snapshots, PTZ). RTSP was chosen because it
  needs nothing but the camera account.
- Sources: [Tapo FAQ 724 – ONVIF and RTSP common questions](https://www.tapo.com/faq/724/),
  [TP-Link FAQ 2680 – view Tapo on PC/NAS/NVR via RTSP/ONVIF](https://www.omadanetworks.com/en/support/faq/2680/),
  [TP-Link FAQ 4416 – Third-Party Compatibility](https://www.tp-link.com/cz/support/faq/4416),
  [SmartRTSP – Tapo model compatibility, July 2026](https://www.smartrtsp.com/guides/tapo-rtsp-onvif-model-compatibility).

### Kasa
- TP-Link's own FAQ: Kasa cameras don't support ONVIF or RTSP. The guide is honest and points
  to Tapo (same company).
- Source: [TP-Link community KB 582](https://community.tp-link.com/en/smart-home/kb/detail/582).

### Wyze (be honest)
- RTSP returned to **production** firmware for **Cam v3** (4.36.16.5654, 2 Feb 2026, needs
  Wyze app 3.9+) and **Pan v3**. Enable in the camera's Advanced Settings → RTSP, set a 4–10
  character username/password, tap Generate URL, then copy the link. The guide's easy path is
  **paste the link**; the built link uses `/stream0` (main) as current docs show. The old
  standalone RTSP firmware used `/live`; users who still run it can paste their link.
- RTSPS is also offered on port 322 (`rtsps://…:322/stream0`); pasting an rtsps link works.
- **Cam v4**: as of mid-2026 Wyze says RTSP is in development (beta repeatedly slipped:
  "about a month" on 29 Apr 2026, still pending late June). Not released at time of writing,
  so v4/OG/doorbells/battery cams are marked unsupported with a note to come back.
- **docker-wyze-bridge** is not recommended: the original is abandoned and Wyze firmware auth
  changes broke all known forks unless firmware is downgraded. It needs a server, so it's not
  grandma-friendly; users who run it can add its link via "I have a stream link".
- Known issue: the Wyze app may say "GET RTSP Failed" even though the stream works.
- Sources: [Wyze forum – firmware updates 2/2/2026](https://forums.wyze.com/t/wyze-firmware-updates-2-2-2026/340669?page=6),
  [Wyze forum – RTSP for v3 and Pan v3](https://forums.wyze.com/t/rtsp-for-v3-and-pan-v3/338351?page=13),
  [Wyze forum – V4 Cam RTSP update](https://forums.wyze.com/t/v4-cam-rtsp-update/340672?page=2),
  [Wyze forum – Is RTSP ready for prime time?](https://forums.wyze.com/t/is-rtsp-ready-for-prime-time/342360/2),
  [Wyze support – Wyze Cam RTSP](https://support.wyze.com/hc/en-us/articles/360026245231-Wyze-Cam-RTSP),
  [SecuritySpy forum – Wyze v3 RTSP/RTSPS](https://bensoftware.com/forum/discussion/comment/18235/),
  [docker-wyze-bridge fork](https://github.com/IDisposable/docker-wyze-bridge),
  [Wyze forum – v4 bridge 401 errors](https://forums.wyze.com/t/wyze-v4-docker-wyze-bridge-iotc-er-timeout-401-client-error/342218?page=2).

### eufy
- Camera Settings → Storage → **NAS (RTSP)**; pick Event or **Continuous** (the guide says
  Continuous, otherwise the stream only exists during events), set username/password (max 16
  chars, letters/digits/underscore), copy the generated link. Format `rtsp://user:pass@ip:554/live0`.
- Many battery eufyCams on a HomeBase don't offer it. If the setting isn't there, the guide
  says so kindly.
- Give the camera a fixed address in the router, or the link breaks when the IP changes.
- Sources: [eufy – Using NAS Storage step by step](https://service.eufy.com/article-description/Using-NAS-Storage-Step-by-Step),
  [eufy – Device NAS/RTSP configuration guide](https://service.eufy.com/article-description/Device-NAS-RTSP-Configuration-Guide).

### Imou (Dahua-made)
- Username `admin`, password = the **safety code** on the sticker (case-sensitive), even if
  the app password was changed. Dahua-style path `cam/realmonitor?channel=1&subtype=0`.
- Most plugged-in models; battery models (Cell series) generally not.
- Source: [IPCamTalk – Imou Ranger 2 via ONVIF](https://ipcamtalk.com/goto/post?id=681282).

### EZVIZ (Hikvision's consumer brand)
- Username `admin`, password = 6-letter **verification code** on the sticker. Since 2023
  firmware RTSP is off by default; on many models it can be turned on via EZVIZ app → profile →
  Settings → LAN Live View → scan → camera → gear → Local Server Settings → RTSP. If the switch
  isn't there, that model can't share video.
- Sources: [Home Assistant – EZVIZ integration](https://www.home-assistant.io/integrations/ezviz/),
  [IPCamTalk – EZVIZ disables RTSP](https://ipcamtalk.com/threads/ezviz-disables-rtps-for-its-ip-cameras-here-is-the-fix.69927/page-2).

### Reolink
- PoE and plug-in Wi-Fi cameras, NVRs and Home Hubs support RTSP/ONVIF/CGI → Reolink adapter.
- Battery cameras (Argus, Altas, battery doorbell) only work with third-party apps through a
  **Home Hub** (or NVR). 4G/LTE models aren't supported at all.
- Sources: [Reolink – which products support CGI/RTSP/ONVIF](https://support.reolink.com/hc/en-us/articles/900000617826-Which-Reolink-Products-Support-CGI-RTSP-ONVIF),
  [Reolink – battery cameras and 3rd-party software](https://support.reolink.com/hc/en-us/articles/360004441753-Why-Reolink-Battery-Powered-Cameras-Cannot-Work-with-3rd-Party-Software/).

### Amcrest
- Dahua-based; official RTSP format `rtsp://user:pass@ip:554/cam/realmonitor?channel=1&subtype=0`.
  The guide sends people to the Dahua adapter, which gives recordings and events too.
- Source: [Amcrest – Accessing Amcrest products using RTSP](https://support.amcrest.com/hc/en-us/articles/360052688931-Accessing-Amcrest-Products-Using-RTSP).

### Lorex
- Lorex wired NVR/DVR kits are largely Dahua-based (`cam/realmonitor`, channel = camera number)
  → Dahua adapter. Lorex's standalone Wi-Fi and battery cameras (Lorex Home app) are generally
  cloud/app-only. Wi-Fi cameras paired to a Lorex Fusion recorder show up through the recorder.
- Sources: [iSpy – Lorex](https://www.ispyconnect.com/camera/lorex),
  [Home Assistant community – Lorex NVR integration](https://community.home-assistant.io/t/lorex-nvr-integration-2024/762729),
  [Lorex Pro – ONVIF cameras](https://pro.lorex.com/collections/lorex-onvif-security-cameras).

### Swann
- Not every Swann product supports RTSP; Swann says to check the manual. Newer NVRs are
  Hikvision-compatible, some older DVRs Dahua-based, so the guide uses the **ONVIF** adapter
  (works for both families) and says "most Swann NVR and DVR kits". Swann's Wi-Fi/battery
  cameras (Swann Security app) are treated as app-only.
- Sources: [Swann – Access your Swann camera using RTSP](https://support.swann.com/hc/en-us/articles/60259789314713-Access-Your-Swann-Camera-Using-RTSP),
  [SmartRTSP – Swann](https://www.smartrtsp.com/cameras/swann),
  [iSpy – Swann](https://www.ispyconnect.com/camera/swann).

### Annke, Hikvision and other Hikvision OEMs
- Annke is largely Hikvision hardware (ISAPI, `/Streaming/Channels/101`) → Hikvision adapter.
  HiWatch and LTS are listed as search words on the Hikvision tile.
- Source: [SmartRTSP – Annke](https://www.smartrtsp.com/cameras/annke), [iSpy – Annke](https://www.ispyconnect.com/camera/annke).

### Ubiquiti UniFi
- Points to the UniFi Protect adapter; needs a local-only admin (Admins & Users → Restrict to
  local access only). Same steps as the existing catalog hint.

### Ring, Google Nest, Arlo, Blink, SimpliSafe (closed cloud)
- None offers a local RTSP stream in 2026. Nest's Device Access API gives cloud-only events and
  WebRTC/snapshots, not a local stream; Google dropped RTSP in 2023. The app explains kindly that
  it's the maker's choice, suggests keeping their app for those cameras, and offers brands that
  work plus the network scan.
- Sources: [SmartRTSP – Nest](https://www.smartrtsp.com/cameras/nest),
  [SmartRTSP – Blink](https://www.smartrtsp.com/cameras/blink),
  [SmartRTSP – US/EU home camera RTSP](https://www.smartrtsp.com/guides/us-eu-home-camera-rtsp),
  [Ring community – RTSP protocol for Ring devices](https://community.ring.com/t/rtsp-protocol-for-ring-devices/992/25),
  [getscw – RTSP URLs by manufacturer](https://www.getscw.com/decoding/rtsp).

## Adding a brand

1. Add an entry to `GUIDES` in `app/src/systems/guides.ts`: `id`, `name`, `group`, search
   `keywords`, the phone `app` name, and one or more `options` (1–4 short steps each; the
   "Come back here and tap Next" step is added automatically).
2. Pick a target: `stream` (template with `{auth}{host}:{port}`), `system` (an existing adapter),
   or `unsupported` (a kind `why` plus at least one alternative).
3. Add a line to the URL tests if it's a new template, and a section here with sources.
