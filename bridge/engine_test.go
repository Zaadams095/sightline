package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
	"time"
)

type fakePusher struct{ sent []pushMessage }

func (f *fakePusher) send(_ context.Context, m []pushMessage) error {
	f.sent = append(f.sent, m...)
	return nil
}

func msg(t *testing.T, typ, id, cam, sev string, objects, zones []string) []byte {
	t.Helper()
	r := review{ID: id, Camera: cam, StartTime: 1700000000, Severity: sev, Data: reviewData{Objects: objects, Zones: zones}}
	b, _ := json.Marshal(reviewMessage{Type: typ, Before: r, After: r})
	return b
}

func newTestEngine(t *testing.T, d device) (*engine, *fakePusher) {
	t.Helper()
	s, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.put(d); err != nil {
		t.Fatal(err)
	}
	p := &fakePusher{}
	return newEngine(s, p), p
}

func TestRulesAndDedup(t *testing.T) {
	d := device{
		ID: "dev1", PushToken: "ExponentPushToken[x]", SystemID: "sys",
		DefaultRule: rule{Enabled: true, Objects: []string{"person"}, Severities: []string{"alert"}},
		Rules:       map[string]rule{"driveway": {Enabled: true, Zones: []string{"driveway_zone"}, Severities: []string{"alert", "detection"}}},
		CameraNames: map[string]string{"front": "Front Door"},
	}
	e, p := newTestEngine(t, d)

	e.handle(msg(t, "new", "r1", "front", "alert", []string{"person"}, nil))
	e.handle(msg(t, "update", "r1", "front", "alert", []string{"person", "dog"}, nil)) // same review: no repeat
	e.handle(msg(t, "new", "r2", "front", "alert", []string{"car"}, nil))              // object filtered
	e.handle(msg(t, "new", "r3", "front", "detection", []string{"person"}, nil))       // severity filtered
	e.handle(msg(t, "new", "r4", "driveway", "detection", []string{"car"}, []string{"street"}))
	e.handle(msg(t, "new", "r5", "driveway", "detection", []string{"car"}, []string{"driveway_zone"}))
	e.handle(msg(t, "end", "r6", "front", "alert", []string{"person"}, nil)) // end ignored

	if len(p.sent) != 2 {
		t.Fatalf("sent %d, want 2: %+v", len(p.sent), p.sent)
	}
	if p.sent[0].Title != "Person · Front Door" || p.sent[0].Data["cameraId"] != "front" {
		t.Errorf("first = %+v", p.sent[0])
	}
	if p.sent[1].Body != "In driveway zone" {
		t.Errorf("second body = %q", p.sent[1].Body)
	}
}

func TestCooldown(t *testing.T) {
	d := device{ID: "d", PushToken: "ExponentPushToken[x]", CooldownSec: 60,
		DefaultRule: rule{Enabled: true}}
	e, p := newTestEngine(t, d)
	e.handle(msg(t, "new", "a", "cam", "alert", nil, nil))
	e.handle(msg(t, "new", "b", "cam", "alert", nil, nil))
	if len(p.sent) != 1 {
		t.Fatalf("cooldown not applied: %d sent", len(p.sent))
	}
}

func TestQuietHoursAcrossMidnight(t *testing.T) {
	d := device{QuietHours: quietHours{Enabled: true, Start: "23:00", End: "06:30"}, Timezone: "UTC"}
	at := func(h, m int) time.Time { return time.Date(2026, 1, 1, h, m, 0, 0, time.UTC) }
	for _, c := range []struct {
		h, m int
		want bool
	}{{23, 30, true}, {2, 0, true}, {6, 29, true}, {6, 30, false}, {12, 0, false}} {
		if got := inQuietHours(d, at(c.h, c.m)); got != c.want {
			t.Errorf("%02d:%02d = %v, want %v", c.h, c.m, got, c.want)
		}
	}
}

func TestMaskSuppressesStationaryObjects(t *testing.T) {
	d := device{
		ID: "d", PushToken: "ExponentPushToken[x]", DefaultRule: rule{Enabled: true},
		// Mask the left half of the frame (the street).
		Masks:       map[string][][]pt{"front": {{{0, 0}, {0.5, 0}, {0.5, 1}, {0, 1}}}},
		DetectSizes: map[string]size{"front": {Width: 1280, Height: 720}},
	}
	e, p := newTestEngine(t, d)
	event := func(id string, x1, x2 float64) []byte {
		b, _ := json.Marshal(map[string]any{"type": "update", "after": map[string]any{"id": id, "camera": "front", "box": []float64{x1, 300, x2, 600}}})
		return b
	}
	review := func(rid, eid string) []byte {
		r := review{ID: rid, Camera: "front", Severity: "alert", Data: reviewData{Objects: []string{"car"}, Detections: []string{eid}}}
		b, _ := json.Marshal(reviewMessage{Type: "new", Before: r, After: r})
		return b
	}
	// Car driving by on the street (left half only): suppressed.
	e.handleEvent(event("e1", 100, 300))
	e.handleEvent(event("e1", 200, 400))
	e.handle(review("r1", "e1"))
	// Car that pulls into the driveway (right half): alerts.
	e.handleEvent(event("e2", 100, 300))
	e.handleEvent(event("e2", 900, 1100))
	e.handle(review("r2", "e2"))
	// No position data at all: never suppressed.
	e.lastCam = map[string]map[string]int64{}
	e.handle(review("r3", "unknown"))

	if len(p.sent) != 2 || p.sent[0].Data["reviewId"] != "r2" || p.sent[1].Data["reviewId"] != "r3" {
		t.Fatalf("sent = %+v", p.sent)
	}
}

func TestThumbnailRoundTrip(t *testing.T) {
	// Synthetic 1280x720 gradient frame.
	src := image.NewRGBA(image.Rect(0, 0, 1280, 720))
	for y := 0; y < 720; y++ {
		for x := 0; x < 1280; x++ {
			src.Set(x, y, color.RGBA{uint8(x), uint8(y), uint8(x + y), 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, src, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	small, err := tinyJPEG(buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if len(small) > thumbMaxBytes {
		t.Fatalf("thumb %d bytes", len(small))
	}
	sealed, err := sealThumb("0123456789abcdef0123", small)
	if err != nil {
		t.Fatal(err)
	}
	if len(sealed) > 2300 {
		t.Errorf("sealed payload %d bytes, too big for a push", len(sealed))
	}
	got, err := openThumb("0123456789abcdef0123", sealed)
	if err != nil || !bytes.Equal(got, small) {
		t.Fatalf("round trip failed: %v", err)
	}
	if _, err := openThumb("wrong-secret-wrong-secret", sealed); err == nil {
		t.Error("decrypting with the wrong secret must fail")
	}
	if _, err := jpeg.Decode(bytes.NewReader(got)); err != nil {
		t.Errorf("thumbnail is not a valid JPEG: %v", err)
	}
}

func TestSnoozeAndKnownPeople(t *testing.T) {
	d := device{
		ID: "d", PushToken: "ExponentPushToken[x]", DefaultRule: rule{Enabled: true},
		QuietFor: []string{"Zach"},
		Snoozed:  map[string]int64{"back": time.Now().Add(time.Hour).Unix()},
	}
	e, p := newTestEngine(t, d)
	review := func(id, cam string, subLabels ...string) []byte {
		r := review{ID: id, Camera: cam, Severity: "alert", Data: reviewData{Objects: []string{"person"}, SubLabels: subLabels}}
		b, _ := json.Marshal(reviewMessage{Type: "new", Before: r, After: r})
		return b
	}
	e.handle(review("r1", "front", "Zach"))        // only known: quiet
	e.handle(review("r2", "back"))                 // snoozed camera: quiet
	e.handle(review("r3", "front", "Zach", "Bob")) // someone unknown with him: alerts
	if len(p.sent) != 1 || p.sent[0].Data["reviewId"] != "r3" {
		t.Fatalf("sent = %+v", p.sent)
	}
	if p.sent[0].Title != "Zach & Bob · front" || p.sent[0].CategoryID != "camera-alert" {
		t.Errorf("message = %+v", p.sent[0])
	}
}

func TestHealthAlertsOnceUntilResolved(t *testing.T) {
	s, _ := openStore(t.TempDir())
	_ = s.put(device{ID: "d", PushToken: "ExponentPushToken[x]", Health: healthPrefs{Enabled: true, StoragePct: 90},
		CameraNames: map[string]string{"front": "Front Door"}})
	p := &fakePusher{}
	h := newHealthMonitor("http://unused", s, p)

	var st frigateStats
	_ = json.Unmarshal([]byte(`{"cameras":{"front":{"camera_fps":0},"back":{"camera_fps":5}},
		"service":{"storage":{"/media/frigate/recordings":{"total":1000,"used":950,"free":50},"/dev/shm":{"total":1,"used":1}}}}`), &st)
	h.evaluate(st, frigateConfig{}, nil)
	h.evaluate(st, frigateConfig{}, nil) // same problems: no repeats
	if len(p.sent) != 2 {
		t.Fatalf("first poll sent %d: %+v", len(p.sent), p.sent)
	}
	if p.sent[0].Title != "Front Door is offline" && p.sent[1].Title != "Front Door is offline" {
		t.Errorf("missing friendly offline title: %+v", p.sent)
	}

	// Recovers, then goes offline again: alerts again.
	var ok frigateStats
	_ = json.Unmarshal([]byte(`{"cameras":{"front":{"camera_fps":5}}}`), &ok)
	h.evaluate(ok, frigateConfig{}, nil)
	h.evaluate(st, frigateConfig{}, nil)
	if len(p.sent) != 4 {
		t.Fatalf("after recovery sent %d", len(p.sent))
	}

	// Frigate down: only after 3 consecutive failures.
	p.sent = nil
	for i := 0; i < 2; i++ {
		h.evaluate(frigateStats{}, frigateConfig{}, errors.New("connection refused"))
	}
	if len(p.sent) != 0 {
		t.Fatal("down alert fired too early")
	}
	h.evaluate(frigateStats{}, frigateConfig{}, errors.New("connection refused"))
	if len(p.sent) != 1 || p.sent[0].Title != "Frigate isn't responding" {
		t.Fatalf("down alert = %+v", p.sent)
	}
}

func TestHomeMode(t *testing.T) {
	d := device{ID: "d", PushToken: "ExponentPushToken[x]", DefaultRule: rule{Enabled: true},
		AtHome: true, AlertWhenHome: []string{"doorbell"}}
	e, p := newTestEngine(t, d)
	for _, cam := range []string{"backyard", "doorbell"} {
		r := review{ID: "r-" + cam, Camera: cam, Severity: "alert", Data: reviewData{Objects: []string{"person"}}}
		b, _ := json.Marshal(reviewMessage{Type: "new", Before: r, After: r})
		e.handle(b)
	}
	if len(p.sent) != 1 || p.sent[0].Data["cameraId"] != "doorbell" {
		t.Fatalf("home mode sent = %+v", p.sent)
	}
}

func TestDoorbellAndPackages(t *testing.T) {
	base := device{
		ID: "d", PushToken: "ExponentPushToken[x]", SystemID: "sys", CooldownSec: 600,
		DefaultRule: rule{Enabled: true, Objects: []string{"person"}, Severities: []string{"alert"}},
		CameraNames: map[string]string{"door": "Front Door"},
		QuietFor:    []string{"Zach"},
	}
	ring := func(id string, subLabels ...string) []byte {
		r := review{ID: id, Camera: "door", Severity: "detection", Data: reviewData{Objects: []string{"doorbell"}, SubLabels: subLabels}}
		b, _ := json.Marshal(reviewMessage{Type: "new", Before: r, After: r})
		return b
	}

	// Rings bypass the person-only rule, the cooldown and known-people quieting.
	e, p := newTestEngine(t, base)
	e.handle(ring("r1"))
	e.handle(ring("r2", "Zach"))
	if len(p.sent) != 2 {
		t.Fatalf("sent %d rings, want 2: %+v", len(p.sent), p.sent)
	}
	m := p.sent[0]
	if m.Title != "Someone's at the door · Front Door" || m.CategoryID != "doorbell-ring" || m.Priority != "high" ||
		m.InterruptionLevel != "time-sensitive" || m.Data["kind"] != "doorbell" {
		t.Errorf("ring message = %+v", m)
	}

	// Packages follow the camera rule unless package alerts are on.
	e.handle(msg(t, "new", "p1", "porch", "alert", []string{"package"}, nil))
	if len(p.sent) != 2 {
		t.Fatalf("package without package alerts should be filtered by the person rule: %+v", p.sent)
	}
	withPkg := base
	withPkg.PackageAlerts = true
	e2, p2 := newTestEngine(t, withPkg)
	e2.handle(msg(t, "new", "p1", "porch", "alert", []string{"package"}, nil))
	e2.handle(msg(t, "new", "p2", "porch", "alert", []string{"package"}, nil)) // same camera soon after: once
	if len(p2.sent) != 1 {
		t.Fatalf("sent %d package alerts, want 1", len(p2.sent))
	}
	if p2.sent[0].Title != "Package delivered · porch" || p2.sent[0].CategoryID != "camera-alert" || p2.sent[0].InterruptionLevel != "" {
		t.Errorf("package message = %+v", p2.sent[0])
	}

	// A snoozed doorbell stays quiet.
	snoozed := base
	snoozed.Snoozed = map[string]int64{"door": time.Now().Add(time.Hour).Unix()}
	e3, p3 := newTestEngine(t, snoozed)
	e3.handle(ring("r9"))
	if len(p3.sent) != 0 {
		t.Errorf("snoozed doorbell sent %+v", p3.sent)
	}
}
