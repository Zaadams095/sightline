package main

import (
	"log"
	"math"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
)

// "Fewer false alarms that learn" for Instant Alerts. Mirrors app/src/alerts/learning.ts: the
// phone syncs its feedback ("Not important" / "Always tell me") with its device rules and the
// Hub derives the same learned rules from it, so built-in and Instant Alerts quiet the same
// things. Doorbell rings are never quieted; person alerts only when the user confirmed it.
//
// Also the no-service "rain, wind and headlights" heuristic for motion-only alerts. No weather
// service is used: the symptom (object-less motion on many cameras at once, or a blink of
// motion at night) is what matters and is visible right here, while weather data is hourly,
// kilometers wide, and would mean sending the home's location to a third party.

// deviceSmart is embedded in device (engine.go): what the phone syncs for these features.
type deviceSmart struct {
	Learning learningPrefs `json:"learning"`
	Checkins []checkin     `json:"checkins,omitempty"`
}

type learningPrefs struct {
	Feedback  []feedback `json:"feedback"`
	Confirmed []string   `json:"confirmed"`
	// "Ignore likely rain, wind and headlights" (motion-only alerts).
	Conditions bool `json:"conditions"`
	// Rounded location for sunrise/sunset (optional).
	Sun *sunPlace `json:"sun,omitempty"`
}

type alertFeatures struct {
	Camera    string   `json:"camera"`
	Objects   []string `json:"objects"`
	Zones     []string `json:"zones"`
	SubLabels []string `json:"subLabels"`
	Severity  string   `json:"severity"`
	Hour      string   `json:"hour"`
	Light     string   `json:"light"`
	Duration  string   `json:"duration"`
}

type feedback struct {
	alertFeatures
	ID      string `json:"id"`
	At      int64  `json:"at"`
	Verdict string `json:"verdict"` // "not-important" | "important"
}

type learnedRule struct {
	Key          string
	Kind         string // "quiet" | "always"
	Camera       string
	Objects      []string
	Light        string // "day" | "night" | "any"
	Zones        []string
	SubLabels    []string
	Severities   []string
	ShortOnly    bool
	Count        int
	NeedsConfirm bool
	Confirmed    bool
}

const (
	learnMin       = 3
	keepSec        = 120 * 86400
	shortSec       = 8
	longSec        = 60
	burstWindowSec = 10
	burstCameras   = 3
)

func normObjects(objects []string) []string {
	out := []string{}
	for _, o := range uniq(objects) {
		if o != "motion" {
			out = append(out, o)
		}
	}
	sort.Strings(out)
	return out
}

func sortedUniq(in []string) []string {
	out := append([]string{}, uniq(in)...)
	sort.Strings(out)
	return out
}

func durationBucket(start float64, end *float64) string {
	if end == nil || *end < start {
		return "unknown"
	}
	switch d := *end - start; {
	case d < shortSec:
		return "short"
	case d < longSec:
		return "medium"
	}
	return "long"
}

func featuresOf(r backend.Event, loc *time.Location, sun *sunPlace) alertFeatures {
	ts := int64(math.Floor(r.Start))
	return alertFeatures{
		Camera:    r.Camera,
		Objects:   normObjects(r.Objects),
		Zones:     sortedUniq(r.Zones),
		SubLabels: sortedUniq(r.SubLabels),
		Severity:  r.Severity,
		Hour:      hourBucket(time.Unix(ts, 0).In(loc).Hour()),
		Light:     lightAt(ts, loc, sun),
		Duration:  durationBucket(r.Start, r.End),
	}
}

func objKey(objects []string) string {
	if len(objects) == 0 {
		return "motion"
	}
	return strings.Join(objects, "+")
}

func ruleKey(camera string, objects []string, light string) string {
	return camera + "|" + objKey(objects) + "|" + light
}

func unionSorted(lists ...[]string) []string {
	var all []string
	for _, l := range lists {
		all = append(all, l...)
	}
	return sortedUniq(all)
}

// learnRules derives the learned rules from feedback (latest opinion per event).
func learnRules(p learningPrefs, now int64) []learnedRule {
	// One opinion per event: the latest wins (the app already dedupes; be safe).
	latest := map[string]feedback{}
	var order []string
	for _, f := range p.Feedback {
		k := f.Camera + "\x00" + f.ID
		if _, ok := latest[k]; !ok {
			order = append(order, k)
		}
		if old, ok := latest[k]; !ok || f.At >= old.At {
			latest[k] = f
		}
	}
	groups := map[string][]feedback{}
	var gorder []string
	for _, k := range order {
		f := latest[k]
		f.Objects = normObjects(f.Objects)
		if now-f.At >= keepSec || slices.Contains(f.Objects, "doorbell") {
			continue
		}
		g := f.Camera + "|" + objKey(f.Objects)
		if _, ok := groups[g]; !ok {
			gorder = append(gorder, g)
		}
		groups[g] = append(groups[g], f)
	}
	var out []learnedRule
	for _, g := range gorder {
		list := groups[g]
		camera, objects := list[0].Camera, list[0].Objects
		lastImportant := int64(-1)
		var imp []feedback
		for _, f := range list {
			if f.Verdict == "important" {
				imp = append(imp, f)
				lastImportant = max(lastImportant, f.At)
			}
		}
		var dismissed []feedback
		for _, f := range list {
			if f.Verdict == "not-important" && f.At > lastImportant {
				dismissed = append(dismissed, f)
			}
		}
		if lastImportant >= 0 && len(dismissed) == 0 {
			out = append(out, makeRule("always", camera, objects, "any", imp, p))
			continue
		}
		made := false
		for _, l := range []string{"day", "night"} {
			var fs []feedback
			for _, f := range dismissed {
				if f.Light == l {
					fs = append(fs, f)
				}
			}
			if len(fs) >= learnMin {
				out = append(out, makeRule("quiet", camera, objects, l, fs, p))
				made = true
			}
		}
		if !made && len(dismissed) >= learnMin+1 {
			out = append(out, makeRule("quiet", camera, objects, "any", dismissed, p))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}

func makeRule(kind, camera string, objects []string, light string, fs []feedback, p learningPrefs) learnedRule {
	r := learnedRule{Key: ruleKey(camera, objects, light), Kind: kind, Camera: camera, Objects: objects, Light: light, Count: len(fs),
		Zones: []string{}, SubLabels: []string{}, Severities: []string{}}
	if kind != "quiet" {
		return r
	}
	allZoned, allShort := true, true
	for _, f := range fs {
		allZoned = allZoned && len(f.Zones) > 0
		allShort = allShort && f.Duration == "short"
		r.SubLabels = unionSorted(r.SubLabels, f.SubLabels)
		r.Severities = unionSorted(r.Severities, []string{f.Severity})
		if allZoned {
			r.Zones = unionSorted(r.Zones, f.Zones)
		}
	}
	if !allZoned {
		r.Zones = []string{}
	}
	r.ShortOnly = allShort
	r.NeedsConfirm = slices.Contains(objects, "person")
	r.Confirmed = r.NeedsConfirm && slices.Contains(p.Confirmed, r.Key)
	return r
}

func subset(have, allowed []string) bool {
	for _, h := range have {
		if !slices.Contains(allowed, h) {
			return false
		}
	}
	return true
}

func sameSet(a, b []string) bool { return len(a) == len(b) && subset(a, b) }

func alwaysPinned(f alertFeatures, rules []learnedRule) bool {
	for _, r := range rules {
		if r.Kind == "always" && r.Camera == f.Camera && sameSet(r.Objects, f.Objects) {
			return true
		}
	}
	return false
}

// quietedBy is the quiet rule this alert falls under (nil = alert).
func quietedBy(f alertFeatures, rules []learnedRule) *learnedRule {
	if slices.Contains(f.Objects, "doorbell") || alwaysPinned(f, rules) {
		return nil
	}
	for i, r := range rules {
		switch {
		case r.Kind != "quiet" || r.Camera != f.Camera || !sameSet(r.Objects, f.Objects):
		case r.NeedsConfirm && !r.Confirmed:
		case r.Light != "any" && r.Light != f.Light:
		case len(r.Zones) > 0 && (len(f.Zones) == 0 || !subset(f.Zones, r.Zones)):
		case !subset(f.SubLabels, r.SubLabels):
		case len(r.Severities) > 0 && !slices.Contains(r.Severities, f.Severity):
		case r.ShortOnly && (f.Duration == "medium" || f.Duration == "long"):
		default:
			return &rules[i]
		}
	}
	return nil
}

func isMotionOnly(objects []string) bool {
	for _, o := range objects {
		if o != "motion" {
			return false
		}
	}
	return true
}

type recentTrigger struct {
	Camera     string
	Start      float64
	MotionOnly bool
}

// likelyFalseTrigger: "weather" (object-less motion on 3+ cameras within 10 s) or
// "headlights" (object-less motion at night, over in under 8 s). Mirrors learning.ts.
func likelyFalseTrigger(f alertFeatures, start float64, recent []recentTrigger) string {
	if len(f.Objects) > 0 {
		return ""
	}
	cams := map[string]bool{f.Camera: true}
	for _, r := range recent {
		if r.MotionOnly && math.Abs(r.Start-start) <= burstWindowSec {
			cams[r.Camera] = true
		}
	}
	if len(cams) >= burstCameras {
		return "weather"
	}
	if f.Light == "night" && f.Duration == "short" {
		return "headlights"
	}
	return ""
}

// smartQuietReason: "" to send, else why not ("learned", "weather", "headlights").
func smartQuietReason(f alertFeatures, start float64, rules []learnedRule, conditions bool, recent []recentTrigger) string {
	if slices.Contains(f.Objects, "doorbell") || alwaysPinned(f, rules) {
		return ""
	}
	if quietedBy(f, rules) != nil {
		return "learned"
	}
	if conditions {
		return likelyFalseTrigger(f, start, recent)
	}
	return ""
}

// ---- engine hooks ----

// smartEngine is the engine's state for these features (zero value ready to use).
type smartEngine struct {
	mu       sync.Mutex
	recent   []recentTrigger
	held     map[string]*heldEvent
	released map[string]time.Time
	// now and after are swapped in tests.
	now   func() time.Time
	after func(d time.Duration, f func())
}

type heldEvent struct {
	first time.Time
	ev    backend.Event
}

func (s *smartEngine) clock() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now()
}

// smartHold records the trigger (for the rain/wind pattern) and, for a fresh motion-only
// event while some phone wants conditions filtering, holds it for burstWindowSec: long enough
// to see whether other cameras fire too, and whether it's over in a blink. The event is then
// re-evaluated with what's known by then. Returns true when OnEvent should stop for now.
func (e *engine) smartHold(r backend.Event) bool {
	s := &e.smart
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.clock()
	if s.held == nil {
		s.held, s.released = map[string]*heldEvent{}, map[string]time.Time{}
	}
	mo := isMotionOnly(r.Objects)
	seen := false
	for _, t := range s.recent {
		seen = seen || (t.Camera == r.Camera && t.Start == r.Start)
	}
	if !seen {
		s.recent = append(s.recent, recentTrigger{Camera: r.Camera, Start: r.Start, MotionOnly: mo})
	}
	cutoff := float64(now.Unix()) - 600
	s.recent = slices.DeleteFunc(s.recent, func(t recentTrigger) bool { return t.Start < cutoff })
	if len(s.recent) > 500 {
		s.recent = s.recent[len(s.recent)-500:]
	}
	for id, t := range s.released {
		if now.Sub(t) > 10*time.Minute {
			delete(s.released, id)
		}
	}

	if !mo || isDoorbell(r) {
		return false
	}
	if _, done := s.released[r.ID]; done {
		return false
	}
	if h, ok := s.held[r.ID]; ok {
		h.ev = r // keep the latest version (it may now have an end time)
		return true
	}
	if !e.anyWantsConditions() {
		return false
	}
	s.held[r.ID] = &heldEvent{first: now, ev: r}
	after := s.after
	if after == nil {
		after = func(d time.Duration, f func()) { time.AfterFunc(d, f) }
	}
	id := r.ID
	after(burstWindowSec*time.Second, func() {
		s.mu.Lock()
		h := s.held[id]
		delete(s.held, id)
		s.released[id] = s.clock()
		s.mu.Unlock()
		if h != nil {
			e.OnEvent(h.ev)
		}
	})
	return true
}

func (e *engine) anyWantsConditions() bool {
	for _, d := range e.store.all() {
		if d.Learning.Conditions {
			return true
		}
	}
	return false
}

func (e *engine) recentTriggers() []recentTrigger {
	e.smart.mu.Lock()
	defer e.smart.mu.Unlock()
	return append([]recentTrigger(nil), e.smart.recent...)
}

// smartQuiet reports whether this phone's learned rules or conditions setting quiet the alert.
func (e *engine) smartQuiet(d device, r backend.Event, now time.Time) bool {
	l := d.Learning
	if len(l.Feedback) == 0 && !l.Conditions {
		return false
	}
	f := featuresOf(r, zoneFor(d.Timezone), l.Sun)
	var others []recentTrigger
	for _, t := range e.recentTriggers() {
		if !(t.Camera == r.Camera && t.Start == r.Start) && (e.allow == nil || e.allow(d, t.Camera)) {
			others = append(others, t)
		}
	}
	why := smartQuietReason(f, r.Start, learnRules(l, now.Unix()), l.Conditions, others)
	if why != "" {
		log.Printf("alert %s on %s quieted for device %s: %s", r.ID, r.Camera, shortID(d.ID), why)
	}
	return why != ""
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// addAlertFeatures puts what the phone needs for "Not important" feedback into a push.
func addAlertFeatures(data map[string]string, r backend.Event) {
	data["objects"] = strings.Join(uniq(r.Objects), ",")
	data["zones"] = strings.Join(uniq(r.Zones), ",")
	data["subLabels"] = strings.Join(uniq(r.SubLabels), ",")
	data["severity"] = r.Severity
	if r.End != nil {
		data["end"] = strconv.FormatInt(int64(*r.End), 10)
	}
}
