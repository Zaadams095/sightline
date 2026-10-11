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
	if !out.MutableContent || out.CategoryID != "camera-alert" || out.To != d.PushToken || out.ChannelID != channelAlerts {
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
	if got["v"] != "1" || got["title"] != plain.Title || got["body"] != plain.Body || got["threadId"] != "hub:front_door" {
		t.Errorf("opened = %v, want %q / %q", got, plain.Title, plain.Body)
	}
	for k, v := range plain.Data {
		if k != "thumb" && got[k] != v {
			t.Errorf("data[%s] = %q, want %q", k, got[k], v)
		}
	}
	if _, ok := got["thumb"]; ok {
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
	// Registrations from older apps (no "caps") decode with none.
	var dd device
	if err := json.Unmarshal([]byte(`{"pushToken":"ExponentPushToken[a]"}`), &dd); err != nil || wantsSealed(dd) {
		t.Errorf("decoded %+v %v", dd, err)
	}
	if err := json.Unmarshal([]byte(`{"pushToken":"ExponentPushToken[a]","caps":["enc-msg-v1"]}`), &dd); err != nil || !wantsSealed(dd) {
		t.Errorf("decoded %+v %v", dd, err)
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
	if err != nil || got["cameraId"] != "front_door" {
		t.Errorf("legacy open = %v, %v", got, err)
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
	if got, _ := openSealed(testDeviceSecret, out.Data["enc"]); got["kind"] != "doorbell" || !strings.Contains(got["title"], "Front Door") {
		t.Errorf("opened ring = %v", got)
	}
}

// Android data-only messages: the words in data are sealed too, and what
// app/modules/android-notify does with data.enc (SightlinePush.openSealedMessage: merge every
// key, then title/body onto slTitle/slBody) gives back the message the phone would have got.
func TestSealedAndroidDataOnly(t *testing.T) {
	d := sealedDevice()
	d.Platform = "android"
	plain := buildMessage(d, personAtFrontDoor())
	plain.Data["thumb"] = "c2VhbGVkLXRodW1i"
	out := sealPush(plain, "")
	if out.Title != "" || out.Body != "" || out.MutableContent || out.ChannelID != channelAlerts {
		t.Errorf("Android sealed must stay data-only: %+v", out)
	}
	if out.Data[androidMarker] != "1" || out.Data[androidChannel] != channelAlerts || out.Data[androidCategory] != "camera-alert" ||
		out.Data[androidTitle] != "Activity on your cameras" || out.Data["thumb"] == "" || out.Data["enc"] == "" ||
		out.Data[androidGroup] == "" || out.Data[androidGroup] == plain.Data[androidGroup] {
		t.Errorf("Android visible data = %v", out.Data)
	}
	assertNoDetails(t, out)

	opened, err := openSealed(testDeviceSecret, out.Data["enc"])
	if err != nil {
		t.Fatal(err)
	}
	merged := map[string]string{}
	for k, v := range out.Data {
		merged[k] = v
	}
	for k, v := range opened {
		merged[k] = v
	}
	if _, ok := opened[androidTitle]; !ok {
		merged[androidTitle] = opened["title"]
	}
	if _, ok := opened[androidBody]; !ok {
		merged[androidBody] = opened["body"]
	}
	delete(merged, "enc")
	for _, k := range []string{androidTitle, androidBody, androidChannel, androidCategory, "cameraId", "systemId", "start", "reviewId", "thumb"} {
		if merged[k] != plain.Data[k] {
			t.Errorf("merged[%s] = %q, want %q", k, merged[k], plain.Data[k])
		}
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
	if err := sp.send(context.Background(), msgs); err != nil {
		t.Fatal(err)
	}
	// Health notices, through the monitor itself.
	st, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := st.put(d); err != nil {
		t.Fatal(err)
	}
	hm := &healthMonitor{label: "Frigate", store: st, pusher: sp, active: map[string]bool{}}
	hm.evaluateHealth(backend.Health{Offline: []string{"front_door"}}, nil)

	wantTitles := []string{"Les Alertes instantanées fonctionnent", "Activité sur vos caméras", "Nouvelles de la veille familiale", "Votre Sightline Hub a besoin d’un coup d’œil"}
	if len(fp.sent) != len(wantTitles) {
		t.Fatalf("sent %d: %+v", len(fp.sent), fp.sent)
	}
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

// A fixed vector shared with app/test/sealed.test.ts (the app opens what the Hub seals).
const (
	vectorSecret = "0123456789abcdef-vector"
	vectorEnc    = "YPxCa8hdoROqmIYV8AiWTvQOnB5krvKXKC/QAbKfLb6cDNk1GXtwna++EMq0oEAhfubKDAo3btr7vfUAUMKeDarY05jkwOqLKIKeAqBISzveg5IZ6Zc84BN0Jmo9j/dQvY5vfrC/NDKjic87u3XSCAH2xpsyVU/p2S4D5H0FfqV1RIB324zZz9WRu//S1k0Os4Pbjsm7vIk850ayg8FtA4UHCkrrex9yXOkpRDIp/4YahS66b23Rhcdln1E/hwarhmEk5P2g"
)

func TestSealedVectorForApp(t *testing.T) {
	got, err := openSealed(vectorSecret, vectorEnc)
	if err != nil {
		t.Fatal(err)
	}
	if got["title"] != "Person · Front Door" || got["cameraId"] != "front_door" || got["threadId"] != "hub:front_door" {
		t.Errorf("vector = %v", got)
	}
}
