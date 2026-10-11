package main

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"testing"

	"github.com/zachadams/sightline/bridge/backend"
)

func pev(objs ...string) backend.Event {
	return backend.Event{ID: "r", Camera: "door", Start: 100, Objects: objs}
}

func TestNormPlatform(t *testing.T) {
	for in, want := range map[string]string{"": "ios", "ios": "ios", "android": "android", " Android ": "android", "web": "ios"} {
		if got := normPlatform(in); got != want {
			t.Errorf("normPlatform(%q) = %q, want %q", in, got, want)
		}
	}
	var d device
	if err := json.Unmarshal([]byte(`{"pushToken":"ExponentPushToken[a]","platform":"android"}`), &d); err != nil || d.Platform != "android" {
		t.Fatalf("decode platform: %v %q", err, d.Platform)
	}
}

// iPhones keep the full message (the notification extension adds the picture); the channel
// is set too and ignored there.
func TestIOSMessageShapeUnchanged(t *testing.T) {
	d := device{PushToken: "ExponentPushToken[i]", SystemID: "sys", CameraNames: map[string]string{"door": "Front Door"}}
	m := buildMessage(d, pev("person", "doorbell"))
	if m.Title == "" || m.CategoryID != "doorbell-ring" || m.InterruptionLevel != "time-sensitive" || !m.MutableContent ||
		m.ChannelID != channelDoorbell || m.Data[androidMarker] != "" {
		t.Errorf("iOS ring = %+v", m)
	}
	if m := buildMessage(d, pev("package")); m.ChannelID != channelPackages || m.Title == "" {
		t.Errorf("iOS package = %+v", m)
	}
	if m := buildMessage(d, pev("person")); m.ChannelID != channelAlerts {
		t.Errorf("iOS alert = %+v", m)
	}
}

func TestAndroidMessageIsDataOnly(t *testing.T) {
	d := device{PushToken: "ExponentPushToken[a]", SystemID: "sys", Platform: "android", CameraNames: map[string]string{"door": "Front Door"}}
	ios := d
	ios.Platform = ""
	want := buildMessage(ios, pev("person", "doorbell"))
	m := buildMessage(d, pev("person", "doorbell"))
	if m.Title != "" || m.Body != "" || m.Sound != "" || m.CategoryID != "" || m.ThreadID != "" || m.MutableContent || m.InterruptionLevel != "" {
		t.Errorf("Android message must be data-only: %+v", m)
	}
	if m.To != d.PushToken || m.Priority != "high" || m.ChannelID != channelDoorbell {
		t.Errorf("Android message = %+v", m)
	}
	if m.Data[androidMarker] != "1" || m.Data[androidTitle] != want.Title || m.Data[androidChannel] != channelDoorbell ||
		m.Data[androidCategory] != "doorbell-ring" || m.Data[androidGroup] != want.ThreadID || m.Data["kind"] != "doorbell" ||
		m.Data["cameraId"] != want.Data["cameraId"] {
		t.Errorf("Android data = %v", m.Data)
	}
	// The JSON Expo receives has no title/body, so Android never shows it on its own.
	b, _ := json.Marshal(m)
	var raw map[string]any
	_ = json.Unmarshal(b, &raw)
	for _, k := range []string{"title", "body", "sound", "categoryId", "mutableContent"} {
		if _, ok := raw[k]; ok {
			t.Errorf("Android JSON has %q: %s", k, b)
		}
	}
}

// End to end through the engine: an Android phone gets the encrypted thumbnail in its data,
// and the whole message still fits FCM's 4 KB.
func TestAndroidPushCarriesThumbnail(t *testing.T) {
	d := device{
		ID: "a", PushToken: "ExponentPushToken[a]", SystemID: "sys", Platform: "android", ThumbKey: "0123456789abcdef-a",
		DefaultRule: rule{Enabled: true}, CameraNames: map[string]string{"door": "Front Door"},
	}
	e, p := newTestEngine(t, d)
	src := image.NewRGBA(image.Rect(0, 0, 640, 360))
	for y := 0; y < 360; y++ {
		for x := 0; x < 640; x++ {
			src.Set(x, y, color.RGBA{uint8(x), uint8(y), uint8(x ^ y), 255})
		}
	}
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, src, &jpeg.Options{Quality: 90})
	e.snapshot = func(context.Context, string, int) ([]byte, error) { return buf.Bytes(), nil }
	e.handle(msg(t, "new", "r1", "door", "alert", []string{"person"}, []string{"porch"}))
	if len(p.sent) != 1 {
		t.Fatalf("sent %d", len(p.sent))
	}
	m := p.sent[0]
	if m.Data["thumb"] == "" || m.Data[androidMarker] != "1" || m.Data[androidChannel] != channelAlerts || m.Data[androidCategory] != "camera-alert" {
		t.Fatalf("Android alert = %+v", m)
	}
	if _, err := openThumb(d.ThumbKey, m.Data["thumb"]); err != nil {
		t.Errorf("thumb does not open with the phone's key: %v", err)
	}
	if b, _ := json.Marshal(m); len(b) > 4000 {
		t.Errorf("Android push is %d bytes, too big for FCM", len(b))
	}
}

func TestOtherPushesUseTheirChannels(t *testing.T) {
	d := device{PushToken: "ExponentPushToken[a]", SystemID: "sys", Platform: "android"}
	c := checkin{ID: "mom", Cameras: []string{"kitchen"}}
	m := checkinMessage(d, c, checkinState{}, checkinNotice{Kind: "missed", Title: "Mom", Body: "No one in the kitchen"})
	if m.Data[androidChannel] != channelCheckins || m.Data[androidCategory] != "checkin-mom" || m.Data[androidTitle] != "Mom" || m.Data["kind"] != "checkin" {
		t.Errorf("check-in = %+v", m)
	}
	p := &fakePusher{}
	if err := sendTestPush(context.Background(), p, d); err != nil || len(p.sent) != 1 || p.sent[0].Data[androidChannel] != channelAlerts || p.sent[0].Data[androidTitle] == "" {
		t.Errorf("test push = %+v %v", p.sent, err)
	}
}
