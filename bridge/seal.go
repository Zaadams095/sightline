package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
)

// End-to-end sealed push text ("enc-msg-v1").
//
// A push travels through Expo's push service and Apple (APNs) or Google (FCM). For phones that
// advertise caps ["enc-msg-v1"] at registration, everything that says what happened is sealed
// so only the phone can read it:
//
//   - The visible title/text become generic, in the phone's language ("Activity on your
//     cameras" / "Open Sightline to see more."; "Doorbell" for a ring). See i18n.go sealed.*.
//   - The real title, text, thread and every data field go into data.enc:
//     base64(nonce[12] || AES-256-GCM ciphertext || tag[16]), no additional data, of one flat
//     JSON object of strings:
//     {"v":"1","title":"Person · Front Door","body":"In Driveway","threadId":"hub:front_door",
//     "systemId":"hub","cameraId":"front_door","start":"…","reviewId":"…","kind":"…",…}
//     with key = SHA256("sightline-msg-v1:" + device secret). The device secret is the same
//     one the inline thumbnail uses (deviceSecret); thumb.go derives a different key from it.
//     Data keys never collide with v/title/body/threadId.
//   - Left visible: data.thumb (sealed with the thumbnail key), the category (picks the
//     buttons), the interruption level, and on Android the channel and the slPush marker. The
//     thread/group id is replaced by an opaque hash.
//
// Opening it, all of which merge the object back over the visible data and drop "enc":
//   - iOS: the Notification Service Extension (app/targets/notification-service) before the
//     notification is shown, so the app's tap handling sees the same data as before.
//   - Android: app/modules/android-notify (SightlinePush.openSealedMessage) on data-only
//     messages; it maps title/body onto slTitle/slBody.
//   - The app's JS, when a notification still arrives sealed (app/src/alerts/sealed.ts).
//
// Phones that don't advertise the cap (older app versions) keep getting today's plaintext.
// A phone that advertises it but has no secret here gets the generic text only, never details.

const (
	capEncMsg     = "enc-msg-v1"
	msgKeyContext = "sightline-msg-v1:"
	// APNs and FCM allow 4 KB per push; leave room for Expo's and Apple's envelope.
	maxPushBytes = 3600
)

// Keys of the sealed object besides the data fields.
const (
	sealedVersion = "v"
	sealedTitle   = "title"
	sealedBody    = "body"
	sealedThread  = "threadId"
)

func msgKey(secret string) []byte {
	k := sha256.Sum256([]byte(msgKeyContext + secret))
	return k[:]
}

// deviceSecret is what a phone decrypts its pushes with ("" = none): the per-phone key it
// registered, or for legacy BRIDGE_SECRET pairings the shared secret.
func deviceSecret(d device, legacySecret string) string {
	if d.ThumbKey != "" {
		return d.ThumbKey
	}
	if d.GrantID == "" {
		return legacySecret
	}
	return ""
}

func wantsSealed(d device) bool { return contains(d.Caps, capEncMsg) }

// pushTo starts a push for one phone; the device rides along (unserialized) for sealing.
func pushTo(d device) pushMessage {
	return pushMessage{To: d.PushToken, dev: &d}
}

// visibleAndroid are the data keys of an Android data-only message that stay readable: what
// the app's push service needs before it has opened anything.
var visibleAndroid = map[string]bool{androidMarker: true, androidChannel: true, androidCategory: true}

// sealPush returns m as it should leave the Hub for its device: unchanged for phones without
// the cap (and messages without a device), otherwise generic text + data.enc.
func sealPush(m pushMessage, legacySecret string) pushMessage {
	if m.dev == nil || !wantsSealed(*m.dev) {
		return m
	}
	d := *m.dev
	lang := normLang(d.Lang)
	android := m.Data[androidMarker] == "1"
	gTitle, gBody := tr(lang, sealedGist(m)), tr(lang, "sealed.body")

	inner := map[string]string{sealedVersion: "1"}
	out := m
	out.Data = map[string]string{}
	if android {
		// Data-only (push.go forDevice): the words live in data.
		inner[sealedTitle], inner[sealedBody], inner[sealedThread] = m.Data[androidTitle], m.Data[androidBody], m.Data[androidGroup]
		for k := range visibleAndroid {
			if v, ok := m.Data[k]; ok {
				out.Data[k] = v
			}
		}
		out.Data[androidTitle], out.Data[androidBody] = gTitle, gBody
	} else {
		inner[sealedTitle], inner[sealedBody], inner[sealedThread] = m.Title, m.Body, m.ThreadID
		out.Title, out.Body, out.ThreadID = gTitle, gBody, ""
		// The phone rewrites the text before it's shown (iOS Notification Service Extension).
		out.MutableContent = true
	}
	for k, v := range m.Data {
		if k == "thumb" || (android && (visibleAndroid[k] || k == androidTitle || k == androidBody || k == androidGroup)) {
			continue
		}
		if _, meta := inner[k]; !meta {
			inner[k] = v
		}
	}

	secret := deviceSecret(d, legacySecret)
	if secret == "" {
		return out // nothing the phone could open: generic text only, never details
	}
	raw, err := json.Marshal(inner)
	if err != nil {
		return out
	}
	enc, err := sealGCM(msgKey(secret), raw)
	if err != nil {
		log.Printf("sealing push: %v", err)
		return out
	}
	out.Data["enc"] = enc
	if t := inner[sealedThread]; t != "" {
		if android {
			out.Data[androidGroup] = opaqueThread(secret, t)
		} else {
			out.ThreadID = opaqueThread(secret, t)
		}
	}
	if t := m.Data["thumb"]; t != "" {
		out.Data["thumb"] = t
		// Too big for one push with the picture: the words matter more.
		if b, _ := json.Marshal(out); len(b) > maxPushBytes {
			delete(out.Data, "thumb")
		}
	}
	return out
}

// sealedGist is the i18n key of the generic visible title.
func sealedGist(m pushMessage) string {
	if m.gist != "" {
		return m.gist
	}
	switch m.Data["kind"] {
	case "doorbell":
		return "sealed.doorbell"
	case "checkin":
		return "sealed.checkin"
	}
	return "sealed.activity"
}

// opaqueThread groups a phone's notifications the same way without saying which camera.
func opaqueThread(secret, thread string) string {
	h := sha256.Sum256([]byte("sightline-thread-v1:" + secret + ":" + thread))
	return hex.EncodeToString(h[:8])
}

// openSealed is the phone's side, for tests and tools.
func openSealed(secret, enc string) (map[string]string, error) {
	raw, err := openGCM(msgKey(secret), enc)
	if err != nil {
		return nil, err
	}
	var m map[string]string
	err = json.Unmarshal(raw, &m)
	return m, err
}

// sealingPusher seals every message for its device just before it leaves the Hub, so no code
// path (alerts, health, check-ins, test) can forget to.
type sealingPusher struct {
	next   pusher
	secret string // legacy BRIDGE_SECRET
}

func (p *sealingPusher) send(ctx context.Context, msgs []pushMessage) error {
	out := make([]pushMessage, len(msgs))
	for i, m := range msgs {
		out[i] = sealPush(m, p.secret)
	}
	return p.next.send(ctx, out)
}
