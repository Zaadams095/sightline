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
//   - The visible title/body become generic, in the phone's language ("Activity on your
//     cameras" / "Open Sightline to see more."; "Doorbell" for a ring). See i18n.go sealed.*.
//   - The real title, body, thread and every data field go into data.enc:
//     base64(nonce[12] || AES-256-GCM ciphertext || tag[16]) of the JSON
//     {"v":1,"title":"Person · Front Door","body":"In driveway","threadId":"hub:front","data":{...}}
//     with key = SHA256("sightline-msg-v1:" + device secret). The device secret is the same one
//     the inline thumbnail uses (deviceSecret; thumb.go derives a different key from it).
//   - Beside data.enc only data.thumb stays (already sealed with the thumbnail key). The
//     thread id is replaced by an opaque hash; category and interruption level stay as they are
//     (they only pick buttons and Focus behavior).
//
// iOS: the Notification Service Extension (app/targets/notification-service) opens data.enc
// and puts the real title, body, thread and data back before the notification is shown, so
// the app's tap handling sees the same data as before. JS opens it too when a notification
// arrives unopened (app/src/alerts/sealed.ts). Android: a native FCM handler must do the
// same (docs/ANDROID.md, "Sealed Instant Alerts"); until then Android shows the generic text and
// the app opens data.enc when the notification is tapped.
//
// Phones that don't advertise the cap (older app versions) keep getting today's plaintext.
// A phone that advertises it but has no secret here gets the generic text only, never details.

const (
	capEncMsg     = "enc-msg-v1"
	msgKeyContext = "sightline-msg-v1:"
	// APNs allows 4 KB per push; leave room for Expo's and Apple's envelope.
	maxPushBytes = 3600
)

// sealedMsg is the plaintext inside data.enc.
type sealedMsg struct {
	V        int               `json:"v"`
	Title    string            `json:"title"`
	Body     string            `json:"body,omitempty"`
	ThreadID string            `json:"threadId,omitempty"`
	Data     map[string]string `json:"data,omitempty"`
}

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

// to starts a push for one phone; the device rides along (unserialized) for sealing.
func pushTo(d device) pushMessage {
	return pushMessage{To: d.PushToken, dev: &d}
}

// sealPush returns m as it should leave the Hub for its device: unchanged for phones without
// the cap (and messages without a device), otherwise generic text + data.enc.
func sealPush(m pushMessage, legacySecret string) pushMessage {
	if m.dev == nil || !wantsSealed(*m.dev) {
		return m
	}
	d := *m.dev
	lang := normLang(d.Lang)
	out := m
	out.Title = tr(lang, sealedGist(m))
	out.Body = tr(lang, "sealed.body")
	out.ThreadID = ""
	out.Data = map[string]string{}
	// The phone rewrites the text before it's shown (iOS Notification Service Extension).
	out.MutableContent = true

	secret := deviceSecret(d, legacySecret)
	if secret == "" {
		return out // nothing the phone could open: generic text only, never details
	}
	inner := sealedMsg{V: 1, Title: m.Title, Body: m.Body, ThreadID: m.ThreadID, Data: map[string]string{}}
	for k, v := range m.Data {
		if k == "thumb" {
			continue
		}
		inner.Data[k] = v
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
	if m.ThreadID != "" {
		out.ThreadID = opaqueThread(secret, m.ThreadID)
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
func openSealed(secret, enc string) (sealedMsg, error) {
	var m sealedMsg
	raw, err := openGCM(msgKey(secret), enc)
	if err != nil {
		return m, err
	}
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
