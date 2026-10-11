package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
)

// Schedule cases mirror app/test/checkins.test.ts; the runner tests use a fake clock.

var chicago = zoneFor("America/Chicago")

func cAt(y, m, d, h, mi int) int64 {
	return time.Date(y, time.Month(m), d, h, mi, 0, 0, chicago).Unix()
}

func momCheckin() checkin {
	return checkin{
		ID: "mom", Enabled: true, Who: "Mom", Cameras: []string{"kitchen", "hall"},
		CameraNames: map[string]string{"kitchen": "Kitchen", "hall": "Hallway"},
		ByTime:      "10:00", QuietLimitHours: 6, DayStart: "08:00", DayEnd: "21:00", SummaryTime: "20:00",
		Timezone: "America/Chicago", DuringQuietHours: true,
	}
}

func cEv(id string, t int64, camera string) backend.Event {
	end := float64(t + 20)
	return backend.Event{ID: id, Camera: camera, Start: float64(t), End: &end, Objects: []string{"person"}}
}

func due(c checkin, st checkinState, now int64) ([]checkinNotice, checkinState) {
	return dueCheckin("en", c, st, now, false, chicago)
}

func TestCheckinByTime(t *testing.T) {
	c := momCheckin()
	st := checkinState{WatchingSince: cAt(2026, 10, 1, 8, 0)}
	st = observeCheckin(c, st, cEv("a", cAt(2026, 10, 1, 21, 15)-20, "kitchen"), cAt(2026, 10, 1, 21, 15), chicago)
	if n, _ := due(c, st, cAt(2026, 10, 2, 9, 59)); len(n) != 0 {
		t.Fatalf("early: %+v", n)
	}
	n, st := due(c, st, cAt(2026, 10, 2, 10, 0))
	want := checkinNotice{Kind: "by-time", Title: "No activity at Mom’s yet today", Body: "It’s 10:00 AM. Kitchen was last active yesterday at 9:15 PM."}
	if len(n) != 1 || n[0] != want {
		t.Fatalf("got %+v", n)
	}
	if n, _ := due(c, st, cAt(2026, 10, 2, 10, 1)); len(n) != 0 {
		t.Fatalf("repeated: %+v", n)
	}
}

func TestCheckinSummary(t *testing.T) {
	c := momCheckin()
	st := checkinState{WatchingSince: cAt(2026, 10, 1, 8, 0)}
	obs := func(e backend.Event, now int64) { st = observeCheckin(c, st, e, now, chicago) }
	obs(cEv("a", cAt(2026, 10, 2, 7, 42), "kitchen"), cAt(2026, 10, 2, 7, 43))
	obs(cEv("a", cAt(2026, 10, 2, 7, 42), "kitchen"), cAt(2026, 10, 2, 7, 44))
	obs(cEv("b", cAt(2026, 10, 2, 9, 0), "hall"), cAt(2026, 10, 2, 9, 1))
	obs(cEv("x", cAt(2026, 10, 2, 9, 5), "garage"), cAt(2026, 10, 2, 9, 6))
	if n, _ := due(c, st, cAt(2026, 10, 2, 10, 0)); len(n) != 0 {
		t.Fatalf("activity seen, got %+v", n)
	}
	obs(cEv("c", cAt(2026, 10, 2, 13, 0), "kitchen"), cAt(2026, 10, 2, 13, 1))
	c.QuietLimitHours = 0
	n, _ := due(c, st, cAt(2026, 10, 2, 20, 0))
	want := checkinNotice{Kind: "summary", Title: "All normal at Mom’s", Body: "First activity 7:42 AM · 3 moments today."}
	if len(n) != 1 || n[0] != want {
		t.Fatalf("got %+v", n)
	}
}

func TestCheckinQuietSpellAndOK(t *testing.T) {
	c := momCheckin()
	st := checkinState{WatchingSince: cAt(2026, 10, 1, 8, 0)}
	st = observeCheckin(c, st, cEv("a", cAt(2026, 10, 2, 8, 30)-20, "kitchen"), cAt(2026, 10, 2, 8, 30), chicago)
	if n, _ := due(c, st, cAt(2026, 10, 2, 14, 29)); len(n) != 0 {
		t.Fatalf("early: %+v", n)
	}
	n, st := due(c, st, cAt(2026, 10, 2, 14, 30))
	if len(n) != 1 || n[0].Kind != "quiet" || n[0].Title != "No activity at Mom’s for 6 hours" || n[0].Body != "Kitchen was last active today at 8:30 AM." {
		t.Fatalf("got %+v", n)
	}
	if n, _ := due(c, st, cAt(2026, 10, 2, 15, 0)); len(n) != 0 {
		t.Fatalf("repeated: %+v", n)
	}
	st.OKAt = cAt(2026, 10, 2, 14, 35)
	n, _ = due(c, st, cAt(2026, 10, 2, 20, 34))
	for _, x := range n {
		if x.Kind == "quiet" {
			t.Fatalf("after OK: %+v", x)
		}
	}
	c.SummaryTime = ""
	if n, _ := due(c, st, cAt(2026, 10, 2, 22, 0)); len(n) != 0 {
		t.Fatalf("outside the day: %+v", n)
	}
}

func TestCheckinMidMorningSetup(t *testing.T) {
	c := momCheckin()
	st := checkinState{WatchingSince: cAt(2026, 10, 2, 11, 0)}
	if n, _ := due(c, st, cAt(2026, 10, 2, 11, 1)); len(n) != 0 {
		t.Fatalf("claimed nothing today: %+v", n)
	}
	if n, _ := due(c, st, cAt(2026, 10, 3, 10, 0)); len(n) == 0 || n[0].Kind != "by-time" {
		t.Fatalf("next day: %+v", n)
	}
}

func TestCheckinQuietHoursChoice(t *testing.T) {
	c := momCheckin()
	st := checkinState{WatchingSince: cAt(2026, 10, 1, 8, 0)}
	c.DuringQuietHours = false
	if n, _ := dueCheckin("en", c, st, cAt(2026, 10, 2, 10, 0), true, chicago); len(n) != 0 {
		t.Fatalf("should wait: %+v", n)
	}
	c.DuringQuietHours = true
	if n, _ := dueCheckin("en", c, st, cAt(2026, 10, 2, 10, 0), true, chicago); len(n) != 1 {
		t.Fatalf("should come through: %+v", n)
	}
}

func TestCheckinDST(t *testing.T) {
	utc := func(y, m, d, h, mi int) int64 { return time.Date(y, time.Month(m), d, h, mi, 0, 0, time.UTC).Unix() }
	if got := atTimeOfDay(cAt(2026, 11, 1, 0, 30), "10:00", chicago); got != utc(2026, 11, 1, 16, 0) {
		t.Errorf("fall back day: %v", time.Unix(got, 0).UTC())
	}
	if got := atTimeOfDay(cAt(2026, 10, 31, 23, 0), "10:00", chicago); got != utc(2026, 10, 31, 15, 0) {
		t.Errorf("day before: %v", time.Unix(got, 0).UTC())
	}
	if got := atTimeOfDay(cAt(2026, 3, 8, 1, 0), "10:00", chicago); got != utc(2026, 3, 8, 15, 0) {
		t.Errorf("spring forward day: %v", time.Unix(got, 0).UTC())
	}
	if dayKey(utc(2026, 11, 2, 5, 30), chicago) != "2026-11-01" || dayKey(utc(2026, 11, 2, 6, 0), chicago) != "2026-11-02" {
		t.Error("day boundary")
	}
	if got := time.Date(2026, 3, 8, 2, 30, 0, 0, chicago).Unix(); got != utc(2026, 3, 8, 7, 30) {
		t.Errorf("skipped time resolves like the app: %v", time.Unix(got, 0).UTC())
	}
	st := checkinState{WatchingSince: cAt(2026, 10, 30, 8, 0)}
	if n, _ := due(momCheckin(), st, utc(2026, 11, 1, 15, 59)); len(n) != 0 {
		t.Fatalf("early on DST day: %+v", n)
	}
	if n, _ := due(momCheckin(), st, utc(2026, 11, 1, 16, 0)); len(n) != 1 || !strings.HasPrefix(n[0].Body, "It’s 10:00 AM.") {
		t.Fatalf("DST day: %+v", n)
	}
}

func TestWhenText(t *testing.T) {
	now := cAt(2026, 10, 7, 12, 0)
	for got, want := range map[string]string{
		whenText("en", cAt(2026, 10, 7, 9, 5), now, chicago):  "today at 9:05 AM",
		whenText("en", cAt(2026, 10, 5, 0, 0), now, chicago):  "on Monday at 12:00 AM",
		whenText("en", cAt(2026, 9, 20, 18, 0), now, chicago): "on Sep 20 at 6:00 PM",
	} {
		if got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	}
}

// ---- runner: fake clock, persistence, recorder double-check, access ----

type fakeClock struct{ t time.Time }

func (f *fakeClock) now() time.Time { return f.t }

func newTestRunner(t *testing.T, dir string, d device, clock *fakeClock) (*checkinRunner, *fakePusher) {
	t.Helper()
	s, err := openStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.put(d); err != nil {
		t.Fatal(err)
	}
	p := &fakePusher{}
	r, err := openCheckins(dir, s, p)
	if err != nil {
		t.Fatal(err)
	}
	r.now = clock.now
	return r, p
}

func checkinDevice() device {
	d := device{ID: "phone", PushToken: "ExponentPushToken[x]", SystemID: "hub1", Timezone: "America/New_York"}
	d.Checkins = []checkin{momCheckin()}
	return d
}

func TestRunnerTimersPersistenceAndOK(t *testing.T) {
	dir := t.TempDir()
	clock := &fakeClock{time.Unix(cAt(2026, 10, 1, 8, 0), 0)}
	r, p := newTestRunner(t, dir, checkinDevice(), clock)
	ctx := context.Background()

	r.tick(ctx) // starts watching (no recorder to backfill from: watched from now)
	r.observe(cEv("a", cAt(2026, 10, 1, 21, 15)-20, "kitchen"))
	clock.t = time.Unix(cAt(2026, 10, 1, 21, 16), 0)
	r.tick(ctx)
	if len(p.sent) != 1 || p.sent[0].Title != "All normal at Mom’s" {
		t.Fatalf("summary day 1: %+v", p.sent)
	}

	// Restart overnight: state comes back from checkins.json.
	clock.t = time.Unix(cAt(2026, 10, 2, 10, 0), 0)
	r2, p2 := newTestRunner(t, dir, checkinDevice(), clock)
	r2.tick(ctx)
	if len(p2.sent) != 1 {
		t.Fatalf("after restart: %+v", p2.sent)
	}
	m := p2.sent[0]
	if m.Title != "No activity at Mom’s yet today" || m.Body != "It’s 10:00 AM. Kitchen was last active yesterday at 9:15 PM." ||
		m.CategoryID != "checkin-mom" || m.Data["cameraId"] != "kitchen" || m.Data["kind"] != "checkin" || m.InterruptionLevel != "time-sensitive" {
		t.Fatalf("message: %+v", m)
	}
	// "Mom's fine" quiets the 6-hour notice that would otherwise follow at 14:00.
	if !r2.markOK("phone", "mom") {
		t.Fatal("markOK")
	}
	clock.t = time.Unix(cAt(2026, 10, 2, 14, 0), 0)
	r2.tick(ctx)
	if len(p2.sent) != 1 {
		t.Fatalf("after OK: %+v", p2.sent[1:])
	}
	clock.t = time.Unix(cAt(2026, 10, 2, 16, 5), 0)
	r2.tick(ctx)
	if len(p2.sent) != 2 || p2.sent[1].Title != "No activity at Mom’s for 6 hours" {
		t.Fatalf("6 hours after OK: %+v", p2.sent)
	}
}

func TestRunnerDoubleChecksWithRecorder(t *testing.T) {
	clock := &fakeClock{time.Unix(cAt(2026, 10, 2, 9, 0), 0)}
	r, p := newTestRunner(t, t.TempDir(), checkinDevice(), clock)
	var asked []float64
	r.recent = func(_ context.Context, cams []string, after float64) ([]backend.Event, error) {
		asked = append(asked, after)
		// The live stream missed a 7:30 kitchen event; the recorder has it.
		return []backend.Event{cEv("missed", cAt(2026, 10, 2, 7, 30), "kitchen")}, nil
	}
	ctx := context.Background()
	r.tick(ctx) // new check-in: backfills since midnight, so today counts as watched
	if len(asked) != 1 || asked[0] != float64(cAt(2026, 10, 2, 0, 0)) {
		t.Fatalf("backfill asked %v", asked)
	}
	clock.t = time.Unix(cAt(2026, 10, 2, 10, 0), 0)
	r.tick(ctx)
	if len(p.sent) != 0 {
		t.Fatalf("activity was there: %+v", p.sent)
	}

	// Recorder unreachable: still tell, and say so.
	clock2 := &fakeClock{time.Unix(cAt(2026, 10, 3, 10, 0), 0)}
	r2, p2 := newTestRunner(t, t.TempDir(), checkinDevice(), clock2)
	r2.states["phone|mom"] = checkinState{WatchingSince: cAt(2026, 10, 1, 0, 0), LastActivity: cAt(2026, 10, 2, 21, 0), LastCamera: "hall"}
	r2.recent = func(context.Context, []string, float64) ([]backend.Event, error) { return nil, errors.New("timeout") }
	r2.tick(ctx)
	if len(p2.sent) != 1 || !strings.HasSuffix(p2.sent[0].Body, "Hallway was last active yesterday at 9:00 PM. Sightline couldn’t reach the recorder to double-check.") {
		t.Fatalf("unverified: %+v", p2.sent)
	}
}

func TestRunnerOnlyCountsCamerasTheGrantAllows(t *testing.T) {
	clock := &fakeClock{time.Unix(cAt(2026, 10, 1, 8, 0), 0)}
	d := checkinDevice()
	d.GrantID = "sister"
	r, p := newTestRunner(t, t.TempDir(), d, clock)
	r.allow = func(d device, camera string) bool { return camera == "hall" }
	r.tick(context.Background())
	r.observe(cEv("k", cAt(2026, 10, 2, 7, 0), "kitchen")) // not hers to see: doesn't count
	clock.t = time.Unix(cAt(2026, 10, 2, 10, 0), 0)
	r.tick(context.Background())
	if len(p.sent) != 1 || p.sent[0].Data["cameraId"] != "hall" || strings.Contains(p.sent[0].Body, "Kitchen") {
		t.Fatalf("got %+v", p.sent)
	}
}
