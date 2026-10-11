package main

import (
	"testing"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
)

// Mirrors app/test/learning.test.ts (same fixtures and expectations).

const learnT0 = int64(1_760_000_000)

var learnBase = alertFeatures{Camera: "driveway", Objects: []string{"car"}, Zones: []string{"street"}, SubLabels: []string{},
	Severity: "detection", Hour: "evening", Light: "night", Duration: "short"}

func fbk(i int, mut func(*feedback)) feedback {
	f := feedback{alertFeatures: learnBase, ID: "e" + itoa(i), At: learnT0 + int64(i)*60, Verdict: "not-important"}
	if mut != nil {
		mut(&f)
	}
	return f
}

func with(f alertFeatures, mut func(*alertFeatures)) alertFeatures {
	f.Objects = append([]string{}, f.Objects...)
	mut(&f)
	return f
}

func rulesOf(fs []feedback, confirmed ...string) []learnedRule {
	return learnRules(learningPrefs{Feedback: fs, Confirmed: confirmed}, learnT0+3600)
}

func TestLearnThreeDismissals(t *testing.T) {
	if n := len(rulesOf([]feedback{fbk(1, nil), fbk(2, nil)})); n != 0 {
		t.Fatalf("two dismissals made %d rules", n)
	}
	rules := rulesOf([]feedback{fbk(1, nil), fbk(2, nil), fbk(3, nil)})
	if len(rules) != 1 || rules[0].Key != "driveway|car|night" {
		t.Fatalf("rules = %+v", rules)
	}
	if quietedBy(learnBase, rules) == nil {
		t.Fatal("cars at night should be quieted")
	}
	still := map[string]alertFeatures{
		"day":       with(learnBase, func(f *alertFeatures) { f.Light = "day" }),
		"person":    with(learnBase, func(f *alertFeatures) { f.Objects = []string{"car", "person"} }),
		"camera":    with(learnBase, func(f *alertFeatures) { f.Camera = "porch" }),
		"zone":      with(learnBase, func(f *alertFeatures) { f.Zones = []string{"driveway"} }),
		"recognize": with(learnBase, func(f *alertFeatures) { f.SubLabels = []string{"ABC123"} }),
		"severity":  with(learnBase, func(f *alertFeatures) { f.Severity = "alert" }),
		"long":      with(learnBase, func(f *alertFeatures) { f.Duration = "long" }),
	}
	for name, f := range still {
		if quietedBy(f, rules) != nil {
			t.Errorf("%s: should still alert", name)
		}
	}
	if quietedBy(with(learnBase, func(f *alertFeatures) { f.Duration = "unknown" }), rules) == nil {
		t.Error("unknown duration should be quieted")
	}
}

func TestLearnSameEventOnce(t *testing.T) {
	if n := len(rulesOf([]feedback{fbk(1, nil), fbk(1, nil), fbk(1, nil)})); n != 0 {
		t.Fatalf("one event counted %d times", n)
	}
}

func TestLearnMixedLight(t *testing.T) {
	day := func(f *feedback) { f.Light = "day" }
	rules := rulesOf([]feedback{fbk(1, nil), fbk(2, nil), fbk(3, day), fbk(4, day)})
	if len(rules) != 1 || rules[0].Light != "any" {
		t.Fatalf("rules = %+v", rules)
	}
}

func TestLearnLatestOpinionWins(t *testing.T) {
	imp := func(f *feedback) { f.Verdict = "important" }
	rules := rulesOf([]feedback{fbk(1, nil), fbk(2, nil), fbk(3, nil), fbk(4, imp)})
	if len(rules) != 1 || rules[0].Kind != "always" || quietedBy(learnBase, rules) != nil {
		t.Fatalf("always pin: %+v", rules)
	}
	rules = rulesOf([]feedback{fbk(1, nil), fbk(2, nil), fbk(3, nil), fbk(4, imp), fbk(5, nil), fbk(6, nil), fbk(7, nil)})
	if len(rules) != 1 || rules[0].Kind != "quiet" {
		t.Fatalf("newer dismissals: %+v", rules)
	}
}

func TestLearnPeopleNeedConfirmation(t *testing.T) {
	person := func(f *feedback) { f.Objects = []string{"person"} }
	fs := []feedback{fbk(1, person), fbk(2, person), fbk(3, person)}
	p := with(learnBase, func(f *alertFeatures) { f.Objects = []string{"person"} })
	if rules := rulesOf(fs); !rules[0].NeedsConfirm || quietedBy(p, rules) != nil {
		t.Fatalf("unconfirmed person rule quieted: %+v", rules)
	}
	if quietedBy(p, rulesOf(fs, "driveway|person|night")) == nil {
		t.Fatal("confirmed person rule should quiet")
	}
}

func TestLearnNeverDoorbell(t *testing.T) {
	ring := func(f *feedback) { f.Objects = []string{"doorbell"} }
	rules := rulesOf([]feedback{fbk(1, ring), fbk(2, ring), fbk(3, ring), fbk(4, ring)})
	if len(rules) != 0 {
		t.Fatalf("doorbell learned: %+v", rules)
	}
	f := with(learnBase, func(f *alertFeatures) { f.Objects = []string{"doorbell"} })
	if smartQuietReason(f, float64(learnT0), rules, true, nil) != "" {
		t.Fatal("doorbell quieted")
	}
}

func TestLearnExpires(t *testing.T) {
	p := learningPrefs{Feedback: []feedback{fbk(1, nil), fbk(2, nil), fbk(3, nil)}}
	if n := len(learnRules(p, learnT0+200*86400)); n != 0 {
		t.Fatalf("old feedback still learned: %d", n)
	}
}

func TestLikelyFalseTrigger(t *testing.T) {
	motion := with(learnBase, func(f *alertFeatures) { f.Objects = []string{}; f.Light = "day"; f.Duration = "unknown" })
	t0 := float64(learnT0)
	recent := []recentTrigger{{Camera: "porch", Start: t0 + 2, MotionOnly: true}, {Camera: "yard", Start: t0 - 4, MotionOnly: true}}
	cases := []struct {
		name   string
		f      alertFeatures
		recent []recentTrigger
		want   string
	}{
		{"burst", motion, recent, "weather"},
		{"two cameras", motion, recent[:1], ""},
		{"too far apart", motion, []recentTrigger{{Camera: "porch", Start: t0 + 30, MotionOnly: true}, recent[1]}, ""},
		{"headlights", with(motion, func(f *alertFeatures) { f.Light = "night"; f.Duration = "short" }), nil, "headlights"},
		{"long at night", with(motion, func(f *alertFeatures) { f.Light = "night"; f.Duration = "long" }), nil, ""},
		{"object", with(motion, func(f *alertFeatures) { f.Objects = []string{"person"} }), recent, ""},
	}
	for _, c := range cases {
		if got := likelyFalseTrigger(c.f, t0, c.recent); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
	night := with(motion, func(f *alertFeatures) { f.Light = "night"; f.Duration = "short" })
	if smartQuietReason(night, t0, nil, false, nil) != "" || smartQuietReason(night, t0, nil, true, nil) != "headlights" {
		t.Error("conditions setting not honored")
	}
}

func TestFeaturesAndSun(t *testing.T) {
	end := float64(learnT0 + 3)
	f := featuresOf(backend.Event{Camera: "c", Objects: []string{"motion", "car", "car"}, Severity: "alert", Start: float64(learnT0), End: &end}, time.UTC, nil)
	if len(f.Objects) != 1 || f.Objects[0] != "car" || f.Duration != "short" {
		t.Fatalf("features = %+v", f)
	}
	london := &sunPlace{Lat: 51.5, Lon: -0.1}
	june := time.Date(2026, 6, 21, 12, 0, 0, 0, time.UTC).Unix()
	if lightAt(june, time.UTC, london) != "day" || lightAt(june-11*3600, time.UTC, london) != "night" {
		t.Error("London midsummer")
	}
	ny := zoneFor("America/New_York")
	dec := time.Date(2026, 12, 15, 22, 30, 0, 0, time.UTC).Unix()
	if lightAt(dec, ny, &sunPlace{Lat: 40.7, Lon: -74}) != "night" || lightAt(dec, ny, nil) != "day" {
		t.Error("New York winter evening")
	}
}

// ---- engine: learned rules and conditions applied to Instant Alerts ----

func smartDevice() device {
	d := device{ID: "dev", PushToken: "ExponentPushToken[x]", SystemID: "sys", Timezone: "UTC", DefaultRule: rule{Enabled: true}}
	recent := func(f *feedback) { f.At = time.Now().Unix() - 3600 + f.At - learnT0 } // the engine uses the real clock
	d.Learning = learningPrefs{Conditions: true, Feedback: []feedback{fbk(1, recent), fbk(2, recent), fbk(3, recent)}}
	return d
}

func TestEngineQuietsLearnedAlerts(t *testing.T) {
	e, p := newTestEngine(t, smartDevice())
	// 23:00 UTC: night without a location.
	start := float64(time.Date(2026, 10, 1, 23, 0, 0, 0, time.UTC).Unix())
	end := start + 3
	ev := func(id string, objects, zones []string) backend.Event {
		return backend.Event{ID: id, Camera: "driveway", Start: start, End: &end, Severity: "detection", Objects: objects, Zones: zones}
	}
	e.OnEvent(ev("car-street", []string{"car"}, []string{"street"}))
	e.OnEvent(ev("car-drive", []string{"car"}, []string{"driveway"}))
	e.OnEvent(ev("ring", []string{"doorbell"}, nil))
	got := map[string]bool{}
	for _, m := range p.sent {
		got[m.Data["reviewId"]] = true
	}
	if got["car-street"] || !got["car-drive"] || !got["ring"] {
		t.Fatalf("sent %v", got)
	}
	// The push carries what "Not important" needs.
	for _, m := range p.sent {
		if m.Data["reviewId"] == "car-drive" && (m.Data["objects"] != "car" || m.Data["zones"] != "driveway" || m.Data["severity"] != "detection" || m.Data["end"] == "") {
			t.Errorf("features in push: %v", m.Data)
		}
	}
}

func TestEngineHoldsMotionForRainAndHeadlights(t *testing.T) {
	d := smartDevice()
	d.Learning.Feedback = nil
	e, p := newTestEngine(t, d)
	clock := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	e.smart.now = func() time.Time { return clock }
	var timers []func()
	e.smart.after = func(_ time.Duration, f func()) { timers = append(timers, f) }
	fire := func() {
		fs := timers
		timers = nil
		for _, f := range fs {
			f()
		}
	}
	start := float64(clock.Unix())
	motion := func(id, cam string, at float64) backend.Event {
		return backend.Event{ID: id, Camera: cam, Start: at, Severity: "detection", Objects: []string{"motion"}}
	}

	// Rain: three cameras within seconds. Held, then all quieted.
	e.OnEvent(motion("a", "front", start))
	e.OnEvent(motion("b", "back", start+2))
	e.OnEvent(motion("c", "side", start+3))
	if len(p.sent) != 0 || len(timers) != 3 {
		t.Fatalf("expected 3 held, sent %d, timers %d", len(p.sent), len(timers))
	}
	fire()
	if len(p.sent) != 0 {
		t.Fatalf("rain burst alerted: %+v", p.sent)
	}

	// One camera alone (later): alerts after the hold.
	e.OnEvent(motion("d", "front", start+120))
	fire()
	if len(p.sent) != 1 || p.sent[0].Data["reviewId"] != "d" {
		t.Fatalf("lone motion: %+v", p.sent)
	}

	// Headlights: night, over in 2 s (the end arrives during the hold).
	night := float64(time.Date(2026, 10, 1, 23, 0, 0, 0, time.UTC).Unix())
	ev := motion("h", "drive", night)
	e.OnEvent(ev)
	end := night + 2
	ev.End = &end
	e.OnEvent(ev)
	fire()
	if len(p.sent) != 1 {
		t.Fatalf("headlights alerted: %+v", p.sent[1:])
	}

	// A person is never held or quieted by conditions.
	e.OnEvent(backend.Event{ID: "p", Camera: "drive", Start: night, Severity: "alert", Objects: []string{"person"}})
	if len(p.sent) != 2 || len(timers) != 0 {
		t.Fatalf("person: sent %d, timers %d", len(p.sent), len(timers))
	}
}

func TestEngineNoHoldWhenConditionsOff(t *testing.T) {
	d := smartDevice()
	d.Learning = learningPrefs{}
	e, p := newTestEngine(t, d)
	e.smart.after = func(time.Duration, func()) { t.Fatal("held without anyone asking") }
	e.OnEvent(backend.Event{ID: "m", Camera: "front", Start: float64(time.Now().Unix()), Severity: "detection", Objects: []string{"motion"}})
	if len(p.sent) != 1 {
		t.Fatalf("sent %d", len(p.sent))
	}
}
