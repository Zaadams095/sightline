package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/zachadams/sightline/bridge/backend"
)

const testDeviceSecret = "0123456789abcdef-phone"

func sealedDevice() device {
	return device{
		ID: "dev1", PushToken: "ExponentPushToken[x]", SystemID: "hub", GrantID: "g1",
		ThumbKey: testDeviceSecret, Caps: []string{capEncMsg},
		CameraNames: map[string]string{"front_door": "Front Door"},
	}
}

func personAtFrontDoor() backend.Event {
	return backend.Event{
		ID: "rev-1", Camera: "front_door", Start: 1700000000, Severity: "alert",
		Objects: []string{"person"}, Zones: []string{"driveway"}, SubLabels: []string{"Alice"},
	}
}

// Nothing that says what happened may be readable outside the phone.
func assertNoDetails(t *testing.T, m pushMessage) {
	t.Helper()
	b, _ := json.Marshal(m)
	for _, leak := range []string{"Front Door", "front_door", "Alice", "driveway", "person", "rev-1", "hub:"} {
		if strings.Contains(string(b), leak) {
			t.Errorf("sealed push leaks %q: %s", leak, b)
		}
	}
}

func TestSealedAlertRoundTrip(t *testing.T) {
	d := sealedDevice()
	plain := buildMessage(d, personAtFrontDoor())
	plain.Data["thumb"] = "c2VhbGVkLXRodW1i"
	out := sealPush(plain, "")

	if out.Title != "Activity on your cameras" || out.Body != "Open Sightline to see more." {
		t.Errorf("visible text = %q / %q", out.Title, out.Body)
	}
	if !out.MutableContent || out.CategoryID != "camera-alert" || out.To != d.PushToken {
		t.Errorf("routing fields changed: %+v", out)
	}
	if len(out.Data) != 2 || out.Data["thumb"] != "c2VhbGVkLXRodW1i" || out.Data["enc"] == "" {
		t.Errorf("visible data = %v", out.Data)
	}
	if out.ThreadID == "" || out.ThreadID == plain.ThreadID {
		t.Errorf("thread = %q, want an opaque one", out.ThreadID)
	}
	assertNoDetails(t, out)

	got, err := openSealed(testDeviceSecret, out.Data["enc"])
	if err != nil {
		t.Fatal(err)
	}
	if got.V != 1 || got.Title != plain.Title || got.Body != plain.Body || got.ThreadID != "hub:front_door" {
		t.Errorf("opened = %+v, want %q / %q", got, plain.Title, plain.Body)
	}
	for k, v := range plain.Data {
		if k != "thumb" && got.Data[k] != v {
			t.Errorf("data[%s] = %q, want %q", k, got.Data[k], v)
		}
	}
	if _, ok := got.Data["thumb"]; ok {
		t.Error("thumbnail sealed twice")
	}
	// The thumbnail key can't open it, nor can another phone's.
	if _, err := openThumb(testDeviceSecret, out.Data["enc"]); err == nil {
		t.Error("thumbnail key opened the message")
	}
	if _, err := openSealed("another-phone-secret", out.Data["enc"]); err == nil {
		t.Error("wrong secret opened the message")
	}
}

func TestSealedKeepsOlderAppsPlaintext(t *testing.T) {
	d := sealedDevice()
	d.Caps = nil
	plain := buildMessage(d, personAtFrontDoor())
	out := sealPush(plain, "")
	if out.Title != plain.Title || out.Data["cameraId"] != "front_door" || out.Data["enc"] != "" {
		t.Errorf("older app got %+v", out)
	}
	// Unknown caps don't turn it on either.
	d.Caps = []string{"something-else"}
	if out := sealPush(buildMessage(d, personAtFrontDoor()), ""); out.Data["enc"] != "" {
		t.Error("sealed without the cap")
	}
}

func TestSealedWithoutKeyIsGenericOnly(t *testing.T) {
	d := sealedDevice()
	d.ThumbKey = "" // a grant registration that never sent a key
	out := sealPush(buildMessage(d, personAtFrontDoor()), "legacy-secret-not-for-grants")
	if out.Title != "Activity on your cameras" || len(out.Data) != 0 {
		t.Errorf("no-key push = %+v", out)
	}
	assertNoDetails(t, out)
}

func TestSealedLegacyPairingUsesBridgeSecret(t *testing.T) {
	d := sealedDevice()
	d.ThumbKey, d.GrantID = "", ""
	out := sealPush(buildMessage(d, personAtFrontDoor()), "legacy-bridge-secret-1234")
	got, err := openSealed("legacy-bridge-secret-1234", out.Data["enc"])
	if err != nil || got.Data["cameraId"] != "front_door" {
		t.Errorf("legacy open = %+v, %v", got, err)
	}
}

func TestSealedGenericTextLocalized(t *testing.T) {
	d := sealedDevice()
	d.Lang = "es"
	ring := personAtFrontDoor()
	ring.Objects = []string{"person", "doorbell"}
	out := sealPush(buildMessage(d, ring), "")
	if out.Title != "Timbre" || out.Body != "Abre Sightline para ver más." || out.InterruptionLevel != "time-sensitive" || out.CategoryID != "doorbell-ring" {
		t.Errorf("es doorbell = %+v", out)
	}
	assertNoDetails(t, out)
	if got, _ := openSealed(testDeviceSecret, out.Data["enc"]); got.Data["kind"] != "doorbell" || !strings.Contains(got.Title, "Front Door") {
		t.Errorf("opened ring = %+v", got)
	}
}

// Every way the Hub pushes goes through the sealing pusher with its device attached.
func TestSealingPusherCoversEveryPush(t *testing.T) {
	fp := &fakePusher{}
	sp := &sealingPusher{next: fp}
	d := sealedDevice()
	d.Health = healthPrefs{Enabled: true}
	d.Lang = "fr"

	if err := sendTestPush(context.Background(), sp, d); err != nil {
		t.Fatal(err)
	}
	c := checkin{ID: "c1", Cameras: []string{"front_door"}}
	msgs := []pushMessage{
		buildMessage(d, personAtFrontDoor()),
		checkinMessage(d, c, checkinState{}, checkinNotice{Kind: "by-time", Title: "No activity at Alice’s", Body: "Front Door"}),
	}
	h := pushTo(d)
	h.Title, h.Body, h.gist = "Front Door is offline", "", "sealed.hub"
	msgs = append(msgs, h)
	if err := sp.send(context.Background(), msgs); err != nil {
		t.Fatal(err)
	}
	if len(fp.sent) != 4 {
		t.Fatalf("sent %d", len(fp.sent))
	}
	wantTitles := []string{"Les Alertes instantanées fonctionnent", "Activité sur vos caméras", "Nouvelles de la veille familiale", "Votre Sightline Hub a besoin d’un coup d’œil"}
	for i, m := range fp.sent {
		if m.Title != wantTitles[i] || m.Data["enc"] == "" || !m.MutableContent {
			t.Errorf("push %d = %+v", i, m)
		}
		assertNoDetails(t, m)
		if _, err := openSealed(testDeviceSecret, m.Data["enc"]); err != nil {
			t.Errorf("push %d: %v", i, err)
		}
	}
}

func TestSealedDropsThumbWhenTooBig(t *testing.T) {
	d := sealedDevice()
	plain := buildMessage(d, personAtFrontDoor())
	plain.Data["thumb"] = strings.Repeat("A", 2200)
	plain.Data["zones"] = strings.Repeat("zone,", 200)
	out := sealPush(plain, "")
	if _, ok := out.Data["thumb"]; ok {
		t.Error("kept a thumbnail that doesn't fit")
	}
	if b, _ := json.Marshal(out); len(b) > 4096 {
		t.Errorf("push is %d bytes", len(b))
	}
}

// A fixed vector shared with app/src/alerts/sealed.test.ts (the app opens what the Hub seals).
const (
	vectorSecret = "0123456789abcdef-vector"
	vectorEnc    = "irGto2pyJpC5PGFWCxCIc6Suq5Ue0nuHk+iEGnYyGNwYX2mUws8UsPpufb/qIY2EhGgGPJLjaVqZ3A4gIzQhYqcQVmTJ1QV8g+UcSrWzdWpLCDKDWwFhOniKAa9LsqiVxefoBJSu3N1BuZvMqZR+qRc512N1+8d15L1LnjUpCMI1RK03dNtpQ5P1KhmIKfFV/hOLnm+rRCYs8J7hap/W6qaBF/933NhHHcpzvoNOMSZHaMbINkhJDxpGlyLQmpxw/emA/14uNHOG0V2F2A=="
)

func TestSealedVectorForApp(t *testing.T) {
	got, err := openSealed(vectorSecret, vectorEnc)
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "Person · Front Door" || got.Data["cameraId"] != "front_door" || got.ThreadID != "hub:front_door" {
		t.Errorf("vector = %+v", got)
	}
}
