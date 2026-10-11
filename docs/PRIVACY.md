# Sightline Privacy Policy

**Effective date: October 11, 2026**

> **Short version:** Sightline has no account and no servers of ours. Your video goes from your
> cameras to your phone.
>
> - We (the developer) never receive your video, pictures, camera passwords, location or
>   anything else about you. We have no database of users, no analytics and no ads.
> - Sightline talks directly to the cameras and recorders you own, at home or over your own
>   private connection.
> - A few features you choose to turn on need outside help: the optional **Sightline Hub**
>   (which runs on your own hardware), **instant alerts** (delivered through Expo, Apple and
>   Google), **remote access** (through your own Tailscale account) and **iCloud backup**
>   (your own iCloud). This policy says exactly what each one sends and where.

This policy covers the Sightline app for iPhone, iPad, Apple Watch and Apple TV, and the
optional Sightline Hub software. Sightline is made by Zach Adams, an individual developer in the
United States ("we", "us").

---

## 1. What Sightline is

Sightline is a viewer for security cameras and recorders you already own: Frigate, Reolink,
Hikvision, Dahua, Amcrest, Lorex, UniFi Protect, Blue Iris, Agent DVR, Shinobi, ZoneMinder,
Scrypted, ONVIF cameras, plain stream (RTSP) cameras and more.

There is no Sightline account, no sign-in and no Sightline cloud. We don't run servers that
your video, pictures or settings pass through.

## 2. Your cameras and recorders

- The app connects **directly** to the cameras and recorders you add, using the address,
  username and password you type in (or that the app finds on your home Wi-Fi when you ask it
  to look).
- At home, this happens on your local network. Away from home, it happens over the connection
  you choose: your own WireGuard VPN (built into the app; you supply the settings from your own
  router or server) or your own Sightline Hub's remote link (see section 3).
- Live video, recordings, snapshots and events go from your equipment to your phone. They
  are not sent to us.
- Camera passwords are kept in the iPhone's Keychain (Apple's encrypted password storage).
- Some cameras and recorders only offer unencrypted connections (plain HTTP or RTSP) on the
  home network. That's how the device itself works; on Wi-Fi you control it stays inside your
  home. For connections from outside your home, use the built-in WireGuard or the Hub's
  encrypted remote link.

## 3. Sightline Hub (optional, runs on your own hardware)

The Sightline Hub is free software you can install on your own computer, Home Assistant box,
NAS or similar. It runs **in your home, under your control**. We can't see it or reach it.

**What your phone sends to your Hub** when you pair it (and again when your alert settings
change):

- a push address for this phone (an "Expo push token"; see section 4) and an ID derived from
  it;
- your alert settings: which cameras and objects to alert on, quiet hours, snoozes, cool-down,
  health alerts, package alerts, activity zones you drew, and camera names;
- your time zone and the app's language (so the Hub can write notifications in it);
- whether you are **home or away** (yes/no only), if you use Home & Away;
- what Sightline learned from your "Not important" / "Always tell me" taps (camera, kinds of
  objects, zones, time of day, and similar features of those alerts) and whether the
  rain/wind/headlights check is on;
- your **family check-ins** (names, cameras, times, and a phone number if you added one for
  "Call");
- if you set a home location for Home & Away: that location **rounded to about 10 km
  (0.1°)**, used only to work out sunrise and sunset for the false-alarm check. Your exact
  location is never sent to the Hub;
- a key the Hub uses to encrypt alert thumbnails so only your phone can open them.

**What the Hub keeps:** the above, the camera systems you add on its setup page (address,
username, password), the people you share with (the name you gave them, what they can see,
when it expires, and scrambled copies of their access keys), a short history of doorbell rings,
and a technical error log. It's all stored on your Hub's disk.

**Sharing.** If you invite someone, the Hub creates a one-time invite code that you send
yourself (Messages, email, etc.). The Hub decides what each person can see and you can revoke
access at any time in **Settings → Sharing**.

**Remote access (optional).** If you turn on remote access, the Hub joins **your own
Tailscale account** and gets a public web address (`https://<name>.<your-tailnet>.ts.net`,
using Tailscale Funnel). Connections to it are encrypted end to end to your Hub (HTTPS that
ends on the Hub). Tailscale's servers help make the connection and may relay encrypted traffic
they can't read. Tailscale sees connection information such as IP addresses and the device
names in your Tailscale account, under
[Tailscale's privacy policy](https://tailscale.com/privacy-policy). Because the address is
public, it shows up in public certificate logs, as all HTTPS sites do; the Hub only answers
people holding a valid access key.

**Downloading the Hub.** The Hub is distributed through GitHub (source code and container
images). GitHub sees ordinary download information (such as IP address) when your Hub
computer downloads it, under [GitHub's privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).

## 4. Alerts

### Built-in alerts (no Hub)

Without a Hub, the app checks your cameras for new events **from your phone**, when iOS lets
it run in the background, and shows a notification that is created on the phone itself
(a "local notification"). Nothing is sent to anyone.

### Instant alerts (with a Hub)

With a Hub, alerts arrive in seconds through the push systems built into phones:

```
Your Hub → Expo Push Service → Apple Push Notification service (iPhone) / Google Firebase Cloud Messaging (Android) → your phone
```

- **Registering for push.** When you connect a Hub, the app asks iOS for this phone's push
  token and sends it, with a random installation ID, the app's identifier and our Expo project
  ID, to **Expo** (650 Industries, Inc.), which returns the Expo push token your Hub uses.
- **What's in an alert:** the notification text (for example "Person at Front Door", or a
  doorbell, package, camera-offline or check-in message), which includes **your camera's name,
  the kinds of things detected, zone names, and names of people or plates your recorder
  recognized** (if your recorder does that), plus technical details the app needs to open the
  right recording (system and camera IDs, event ID and time).
- **The picture is encrypted.** Alerts can carry a tiny thumbnail. Your Hub encrypts it
  (AES-256-GCM) with a key only your phone has, so Expo, Apple and Google can't see it. When
  your phone is at home it may load a bigger picture directly from your Hub instead.
- **The text is not end-to-end encrypted.** Like nearly every app's notifications, the alert
  text passes through Expo and Apple (or Google) in readable form so they can deliver it. It's
  encrypted in transit (HTTPS/TLS). Expo says it does not keep notification contents longer
  than needed to hand them to Apple or Google; it keeps a delivery receipt (success or error,
  not the content) for about a day
  ([Expo push FAQ](https://docs.expo.dev/push-notifications/faq/),
  [Expo privacy policy](https://expo.dev/privacy)). Apple and Google process notifications to
  deliver them under their own privacy policies.
- **Turning it off:** remove the Hub in **Settings → Systems** (tap it, then remove; the app tells the
  Hub to forget this phone), or turn off notifications for Sightline in iOS Settings.

### Learning, check-ins and packages

"Fewer false alarms that learn", family check-ins and package alerts are worked out on your
phone and, if you have one, on your Hub. Nothing goes to us.

## 5. Location (Home & Away)

Home & Away is **off unless you turn it on**. When you do:

- The app records your current position once as "home" and asks iOS to tell it when you
  arrive or leave (iOS region monitoring, which needs "Always" location permission). Sightline
  does not track where you go; it only learns "crossed the home boundary".
- Your **exact home location is stored on your phone**. If iCloud backup is on, it's also
  included in your Sightline settings in **your own iCloud** (section 7), so a new phone
  can set itself up.
- Your **Hub** (if you have one) receives only **home or away** (yes/no), and your home location
  **rounded to about 10 km** for sunrise/sunset times (section 3).
- Turn it off in **Settings → Home & Away → Turn off Home/Away**, and revoke location
  access in iOS Settings → Privacy & Security → Location Services → Sightline.

## 6. On-device intelligence

These features run entirely on your iPhone. Nothing is sent to us, to Apple or anyone else
for them.

- **Ask** (questions like "When did the package arrive?") uses Apple Intelligence's on-device
  model (Apple's Foundation Models framework) on supported iPhones, and otherwise simple
  on-phone matching.
- **Speaking a question** uses Apple's speech recognition **in on-device mode only**. If your
  phone can't recognize your language on the device, Sightline won't use speech rather than
  send your voice to a server.
- **Siri and HomePod.** If you ask Siri about your cameras, Sightline answers from a summary of
  recent events kept on your phone. Siri itself (your spoken request and the answer it speaks)
  is handled by Apple under [Apple's Siri privacy terms](https://www.apple.com/legal/privacy/data/en/ask-siri-dictation/).
- **Share with neighbors** blurs faces and license plates on your phone before you share.

### Familiar faces & vehicles (optional, biometric-related)

This feature is **off unless you turn it on** in **Settings → People & vehicles**. When on:

- Sightline looks at pictures from your own cameras **on your iPhone** using Apple's built-in
  Vision framework, and stores a numerical "feature print" of faces and vehicles plus a small
  cropped picture, together with the names you give them. It may also read license plates.
- This data is used only to put a name on an alert or recording ("Dad at Front Door"). It is
  **never sent to us, to your Hub, or to any other service**, never used for advertising or
  any other purpose, and never sold or shared.
- It is **not** included in Sightline's iCloud settings backup or the phone-to-phone transfer.
  (If you back up your whole iPhone to iCloud or a computer, iOS includes app data in that
  device backup, which Apple stores encrypted under your Apple Account.)
- **Delete it any time:** **Settings → People & vehicles → Forget all faces & vehicles**, or
  remove a single person. Deleting the app deletes it too.
- Your cameras may capture people who haven't agreed to be recognized, such as visitors. Only
  enroll people where you are allowed to, and check the laws where you live (some places,
  such as Illinois, Texas and Washington in the US and the EU/UK, have rules about biometric
  data). Sightline keeps this data on your phone and lets you remove it at any time.

Some recorders (for example Frigate) can recognize faces or plates themselves. That happens on
your recorder, under its settings; Sightline only shows the names your recorder reports, and
those names can appear in instant alert text (section 4).

## 7. iCloud backup and moving to a new phone

- **iCloud backup** (Settings → Backup & new phone) saves your Sightline settings to **your own
  iCloud**: your recorders and cameras (addresses and names, **not** passwords), camera order,
  groups and layouts, alert rules and zones, Home & Away settings including your home location,
  map layout, appearance, saved-clip bookmarks, what Sightline learned from your feedback, and
  family check-ins. Camera passwords, Hub access keys and VPN keys go to **iCloud Keychain**,
  Apple's end-to-end encrypted password sync.
- It never includes video, the picture behind your map, familiar faces & vehicles, or the app
  lock PIN. We can't read your iCloud. Apple stores it under
  [Apple's privacy policy](https://www.apple.com/legal/privacy/).
- To remove it: **Settings → Backup & new phone → Delete iCloud backup**.
- **Phone-to-phone transfer** sends the same settings and passwords straight from your old phone
  to your new one on your home Wi-Fi, encrypted with a one-time key shown in a QR code. It
  works once and expires after 5 minutes. A **backup file** is the same, encrypted with a
  passcode you pick, and goes wherever you send it (AirDrop, Files).

## 8. Permissions

Sightline asks only when a feature needs it. You can say no and still use the rest of the app.

| Permission | Used for |
| --- | --- |
| Local Network | Finding and talking to your cameras at home. |
| Camera | Scanning a QR code (Hub pairing, invites, VPN setup, Apple TV, phone transfer). Nothing is recorded or saved. |
| Microphone | Only while you hold **Talk** (speak through a camera or doorbell; the audio goes to that camera, directly or through your Hub) or while you speak a question to **Ask** (recognized on the phone). |
| Speech Recognition | Turning a spoken question into text, on the device only. |
| Photos | Choosing a floor-plan or map picture, or photos of people and vehicles to recognize. Only the pictures you pick. |
| Notifications | Alerts. |
| Location (When In Use / Always) | Home & Away only (section 5). |
| Face ID / Touch ID | Unlocking the app if you turn on the app lock. Apple handles this; Sightline only gets "yes" or "no". |

## 9. Problem reports and crash data

- **Report a problem** (Settings → Help → Report a problem) builds a report on your phone that you can
  read in full first. It contains your note, app and iOS versions, and a log of recent errors
  with **brand, feature and error type only**; addresses, names, usernames, passwords, tokens,
  pictures and video are removed. It's sent **only if you tap Send**, by your own email app or
  the share sheet, to us at the address in section 18. We use it only to fix the problem and
  reply to you, and delete it when we no longer need it for that. You can turn off
  "Include diagnostics automatically" to send only your note.
- **Apple's crash reports.** If you turned on "Share With App Developers" in iOS Settings →
  Privacy & Security → Analytics & Improvements, Apple sends us anonymous crash logs and
  usage statistics under [Apple's analytics policy](https://www.apple.com/legal/privacy/data/en/analytics/).
  That's Apple's setting, not ours; Sightline adds no crash or analytics SDK.

## 10. App updates (Expo / EAS Update)

Sightline can receive small fixes without a full App Store update, using Expo's EAS Update
service. When the app starts, it asks Expo's update server (`u.expo.dev`) whether a newer
version is available. That request includes technical information: the platform, the app
version and update channel, the current update ID, and a **random installation ID** (Expo's
"EAS client ID", not linked to you, your Apple Account or your device's hardware). Expo uses it
to deliver updates and to count how many installations are updated. Like any internet
request, it reveals your IP address to Expo. It contains nothing about your cameras. See
[Expo's privacy policy](https://expo.dev/privacy).

## 11. Sharing clips and exports

When you share a clip or picture, export evidence for police or insurance, or share with
neighbors, Sightline makes the file on your phone and opens the iOS share sheet. Where it goes
next is your choice (Messages, Mail, AirDrop, Files…), under that service's terms.

## 12. Apple Watch and Apple TV

- The **Apple Watch** app gets your camera list, recent alerts and Hub access from your iPhone
  through Apple's watch connection, and loads snapshots directly from your Hub.
- The **Apple TV** app is paired on your home network by scanning a QR code with your iPhone;
  the iPhone hands it its own Hub invite. No cloud is involved.

## 13. Who else is involved

We don't sell, rent or share personal information, and we don't use it for advertising.
Sightline contains **no advertising, no analytics and no tracking** SDKs, and does not track
you across other companies’ apps or websites. The services below receive only what they need to
do their part (delivering a notification, an update or a connection) and are bound by their own
privacy terms. We use services that protect data at least as well as this policy describes, and
we don't give them anything else.

| Service | When | What they process | Their policy |
| --- | --- | --- | --- |
| Apple | Push delivery (APNs), iCloud backup and Keychain, Siri, App Store, optional analytics | Notification text and tokens; your encrypted iCloud data; standard App Store data | [apple.com/legal/privacy](https://www.apple.com/legal/privacy/) |
| Expo (650 Industries, Inc.) | Instant alerts (only with a Hub); app updates | Push tokens and notification text in transit; update checks with a random installation ID | [expo.dev/privacy](https://expo.dev/privacy) |
| Google | Instant alerts on Android (FCM) | Notification text and tokens in transit | [policies.google.com/privacy](https://policies.google.com/privacy) |
| Tailscale | Hub remote access, only if you turn it on, with your own account | Connection data, encrypted traffic | [tailscale.com/privacy-policy](https://tailscale.com/privacy-policy) |
| GitHub | Downloading the Hub; opening setup guides | Ordinary web request data | [GitHub privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement) |
| Your camera maker | Always (you connect to their device) | Whatever their device does; Sightline doesn't change it | Your camera maker's policy |

## 14. Your rights, retention and deleting your data

- **We don't hold your data.** Because there's no account and no Sightline server, we have no
  copy of your video, settings, location or face data to look up, correct, export or delete.
  The only personal information we may receive is a problem report or email you choose to
  send us.
- **Where your data lives and how to delete it:**
  - *On your phone:* delete the app (or remove individual cameras, faces and settings in the
    app).
  - *In your iCloud:* Settings → Backup & new phone → Delete iCloud backup (or manage it in
    iOS Settings → [your name] → iCloud).
  - *On your Hub:* remove the Hub from the app (the Hub forgets this phone), revoke guests in
    Settings → Sharing, or uninstall the Hub and delete its data folder.
  - *Problem reports you emailed us:* ask us to delete them (section 18).
- **Retention.** We keep problem reports and support emails only as long as needed to help you
  and then delete them. We keep nothing else, because we receive nothing else.
- **Your rights.** Depending on where you live (for example under the EU/UK GDPR, the California
  CCPA/CPRA, or other US state privacy laws), you may have rights to access, correct, delete
  or port your personal information, and to object to or limit its use. Contact us to use
  them; we'll answer within the time the law requires. We don't sell or "share" personal
  information for cross-context behavioral advertising, and we don't use sensitive personal
  information to infer characteristics about you. We won't treat you differently for using
  your rights. If you're in the EU/UK, our legal basis for handling a problem report is your
  consent and our legitimate interest in fixing the app, and you may complain to your data
  protection authority.

## 15. Children

Sightline is not directed to children under 13 (or the minimum age in your country), and we
don't knowingly collect personal information from children. If you believe a child has sent
us information, contact us and we'll delete it.

## 16. Security

Passwords and keys are kept in the iOS Keychain. Remote connections use WireGuard or HTTPS.
Alert pictures are end-to-end encrypted. Hub access uses random per-phone keys stored only as
scrambled copies (hashes), and pairing works only on your home network. The app can be locked
with Face ID, Touch ID or a PIN. No system is perfectly secure: keep your cameras, recorder,
Hub and phone updated and use strong passwords.

## 17. Changes to this policy

If we change this policy, we'll update the effective date above and post the new version at
the same address. If a change affects what leaves your phone, we'll also say so in the app's
release notes.

## 18. Contact

Zach Adams, developer of Sightline (United States)
Email: SUPPORT_EMAIL (support@REPLACE-ME)

---

*Disclaimer for the developer (not part of the published policy): this policy was drafted from
a review of the Sightline source code as of October 2026 and is not legal advice. Have it
reviewed by a qualified lawyer before publishing, particularly the sections on biometric data
(familiar faces), state privacy laws and the GDPR, and re-check it whenever data flows change
(for example the open items in the release notes: location sent to the Hub, push text, and
device-backup inclusion of face data).*
