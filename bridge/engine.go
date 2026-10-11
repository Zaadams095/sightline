package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"
)

// Mirrors app/src/alerts/rules.ts. Keep the two in sync.

type rule struct {
	Enabled    bool     `json:"enabled"`
	Objects    []string `json:"objects"`
	Zones      []string `json:"zones"`
	Severities []string `json:"severities"`
}

type quietHours struct {
	Enabled bool   `json:"enabled"`
	Start   string `json:"start"`
	End     string `json:"end"`
}

type pt struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type size struct {
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type device struct {
	ID          string            `json:"id"`
	PushToken   string            `json:"pushToken"`
	SystemID    string            `json:"systemId"`
	Timezone    string            `json:"timezone"`
	DefaultRule rule              `json:"defaultRule"`
	Rules       map[string]rule   `json:"rules"` // keyed by Frigate camera name
	CameraNames map[string]string `json:"cameraNames"`
	Masks       map[string][][]pt `json:"masks"`
	DetectSizes map[string]size   `json:"detectSizes"`
	QuietHours  quietHours        `json:"quietHours"`
	CooldownSec int64             `json:"cooldownSec"`
	// Recognized names (Frigate sub-labels) that never alert; unrecognized objects always do.
	QuietFor []string `json:"quietFor"`
	// Camera name -> unix seconds until which alerts from it are muted.
	Snoozed map[string]int64 `json:"snoozed"`
	Health  healthPrefs      `json:"health"`
	// Home/Away (from the phone's geofence): while home, only these cameras alert.
	AtHome        bool     `json:"atHome"`
	AlertWhenHome []string `json:"alertWhenHome"`
	// "Package delivered" alerts regardless of the camera's object filter.
	PackageAlerts bool  `json:"packageAlerts"`
	UpdatedAt     int64 `json:"updatedAt"`
}

type healthPrefs struct {
	Enabled    bool `json:"enabled"`
	StoragePct int  `json:"storagePct"`
}

type reviewData struct {
	Objects    []string `json:"objects"`
	SubLabels  []string `json:"sub_labels"`
	Zones      []string `json:"zones"`
	Detections []string `json:"detections"`
}

// frigate/events message (box is in detect-resolution pixels: x1, y1, x2, y2).
type eventMessage struct {
	Type  string `json:"type"`
	After struct {
		ID     string    `json:"id"`
		Camera string    `json:"camera"`
		Box    []float64 `json:"box"`
	} `json:"after"`
}

type review struct {
	ID        string     `json:"id"`
	Camera    string     `json:"camera"`
	StartTime float64    `json:"start_time"`
	Severity  string     `json:"severity"`
	Data      reviewData `json:"data"`
}

type reviewMessage struct {
	Type   string `json:"type"`
	Before review `json:"before"`
	After  review `json:"after"`
}

type engine struct {
	store  *store
	pusher pusher
	snap   *snapshotter
	secret string

	pointsMu sync.Mutex
	points   map[string][][2]float64 // event id -> pixel foot positions seen so far
	seenAt   map[string]time.Time

	mu       sync.Mutex
	notified map[string]bool             // deviceID|reviewID already pushed
	lastCam  map[string]map[string]int64 // deviceID -> camera -> last push (unix)
}

func newEngine(s *store, p pusher) *engine {
	return &engine{
		store: s, pusher: p,
		notified: map[string]bool{}, lastCam: map[string]map[string]int64{},
		points: map[string][][2]float64{}, seenAt: map[string]time.Time{},
	}
}

// handleEvent records where each tracked object's feet were, for alert masks.
func (e *engine) handleEvent(payload []byte) {
	var m eventMessage
	if json.Unmarshal(payload, &m) != nil || len(m.After.Box) != 4 {
		return
	}
	b := m.After.Box
	foot := [2]float64{(b[0] + b[2]) / 2, b[3]}
	e.pointsMu.Lock()
	defer e.pointsMu.Unlock()
	e.points[m.After.ID] = append(e.points[m.After.ID], foot)
	e.seenAt[m.After.ID] = time.Now()
	if len(e.points) > 2000 {
		cutoff := time.Now().Add(-15 * time.Minute)
		for id, t := range e.seenAt {
			if t.Before(cutoff) {
				delete(e.points, id)
				delete(e.seenAt, id)
			}
		}
	}
}

// masked reports whether every known position of the review's objects is inside a mask.
func (e *engine) masked(d device, r review) bool {
	polys := d.Masks[r.Camera]
	sz, ok := d.DetectSizes[r.Camera]
	if len(polys) == 0 || !ok || sz.Width == 0 || sz.Height == 0 {
		return false
	}
	e.pointsMu.Lock()
	defer e.pointsMu.Unlock()
	var pts []pt
	for _, id := range r.Data.Detections {
		for _, p := range e.points[id] {
			pts = append(pts, pt{p[0] / sz.Width, p[1] / sz.Height})
		}
	}
	if len(pts) == 0 {
		return false
	}
	for _, p := range pts {
		inside := false
		for _, poly := range polys {
			if pointInPolygon(p, poly) {
				inside = true
				break
			}
		}
		if !inside {
			return false
		}
	}
	return true
}

func pointInPolygon(p pt, poly []pt) bool {
	if len(poly) < 3 {
		return false
	}
	in := false
	for i, j := 0, len(poly)-1; i < len(poly); j, i = i, i+1 {
		a, b := poly[i], poly[j]
		if (a.Y > p.Y) != (b.Y > p.Y) && p.X < (b.X-a.X)*(p.Y-a.Y)/(b.Y-a.Y)+a.X {
			in = !in
		}
	}
	return in
}

func (e *engine) handle(payload []byte) {
	var m reviewMessage
	if err := json.Unmarshal(payload, &m); err != nil {
		log.Printf("bad review message: %v", err)
		return
	}
	// "new" covers most cases; "update" catches detection→alert upgrades and new objects.
	if m.Type != "new" && m.Type != "update" {
		return
	}
	r := m.After
	now := time.Now()

	var msgs []pushMessage
	e.mu.Lock()
	for _, d := range e.store.all() {
		key := d.ID + "|" + r.ID
		if e.notified[key] {
			continue
		}
		if !shouldNotify(d, r, now) || e.masked(d, r) {
			continue
		}
		cams := e.lastCam[d.ID]
		if cams == nil {
			cams = map[string]int64{}
			e.lastCam[d.ID] = cams
		}
		ring := isDoorbell(r)
		if !ring && now.Unix()-cams[r.Camera] < d.CooldownSec {
			continue
		}
		// One "Package delivered" per camera for a while, not one per event while it sits there.
		pkgKey := "package|" + r.Camera
		if !ring && isPackage(r) {
			if now.Unix()-cams[pkgKey] < packageRepeatSec {
				continue
			}
			cams[pkgKey] = now.Unix()
		}
		cams[r.Camera] = now.Unix()
		e.notified[key] = true
		msgs = append(msgs, buildMessage(d, r))
	}
	if len(e.notified) > 10000 {
		e.notified = map[string]bool{}
	}
	e.mu.Unlock()

	if len(msgs) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if thumb := e.thumbnail(ctx, r.Camera); thumb != "" {
		for i := range msgs {
			msgs[i].Data["thumb"] = thumb
		}
	}
	if err := e.pusher.send(ctx, msgs); err != nil {
		log.Printf("push failed: %v", err)
	}
}

func shouldNotify(d device, r review, now time.Time) bool {
	ru, ok := d.Rules[r.Camera]
	if !ok {
		ru = d.DefaultRule
	}
	if !ru.Enabled {
		return false
	}
	if d.Snoozed[r.Camera] > now.Unix() || (d.AtHome && !contains(d.AlertWhenHome, r.Camera)) || inQuietHours(d, now) {
		return false
	}
	// Doorbell rings always notify (unless the camera is off/snoozed/quiet); package
	// deliveries too when the user turned package alerts on. Mirrors app rules.ts.
	if isDoorbell(r) || (d.PackageAlerts && isPackage(r)) {
		return true
	}
	if len(ru.Severities) > 0 && !contains(ru.Severities, r.Severity) {
		return false
	}
	if len(ru.Objects) > 0 && !anyIn(r.Data.Objects, ru.Objects) {
		return false
	}
	if len(ru.Zones) > 0 && !anyIn(r.Data.Zones, ru.Zones) {
		return false
	}
	return !onlyKnown(r.Data.SubLabels, d.QuietFor)
}

// Doorbell rings are events whose objects include "doorbell"; packages are "package" objects.
func isDoorbell(r review) bool { return contains(r.Data.Objects, "doorbell") }
func isPackage(r review) bool  { return contains(r.Data.Objects, "package") }

const packageRepeatSec = 4 * 3600

// onlyKnown mirrors app/src/alerts/rules.ts: true when everyone recognized is on the quiet list.
func onlyKnown(subLabels, quietFor []string) bool {
	names := uniq(subLabels)
	if len(names) == 0 {
		return false
	}
	for _, n := range names {
		if !contains(quietFor, n) {
			return false
		}
	}
	return true
}

func inQuietHours(d device, now time.Time) bool {
	q := d.QuietHours
	if !q.Enabled {
		return false
	}
	if loc, err := time.LoadLocation(d.Timezone); err == nil && d.Timezone != "" {
		now = now.In(loc)
	}
	mins := func(s string) int {
		var h, m int
		fmt.Sscanf(s, "%d:%d", &h, &m)
		return h*60 + m
	}
	cur := now.Hour()*60 + now.Minute()
	start, end := mins(q.Start), mins(q.End)
	if start <= end {
		return cur >= start && cur < end
	}
	return cur >= start || cur < end
}

func buildMessage(d device, r review) pushMessage {
	name := d.CameraNames[r.Camera]
	if name == "" {
		name = r.Camera
	}
	// Same as the app's titleFor: recognized names first, else object labels.
	what := "Motion"
	objs := uniq(r.Data.Objects)
	if names := uniq(r.Data.SubLabels); len(names) > 0 {
		what = strings.Join(names, " & ")
	} else if len(objs) > 0 {
		for i, o := range objs {
			objs[i] = strings.ToUpper(o[:1]) + strings.ReplaceAll(o[1:], "_", " ")
		}
		what = strings.Join(objs, " & ")
	}
	body := ""
	if len(r.Data.Zones) > 0 {
		body = "In " + strings.ReplaceAll(strings.Join(r.Data.Zones, ", "), "_", " ")
	}
	m := pushMessage{
		To:       d.PushToken,
		Title:    what + " · " + name,
		Body:     body,
		Sound:    "default",
		Priority: "high",
		ThreadID: d.SystemID + ":" + r.Camera,
		Data: map[string]string{
			"systemId": d.SystemID,
			"cameraId": r.Camera,
			"start":    fmt.Sprintf("%d", int64(r.StartTime)-5),
			"reviewId": r.ID,
		},
		MutableContent: true,
		CategoryID:     "camera-alert", // long-press snooze actions, registered by the app
	}
	// Same titles as the app's built-in alerts (rules.ts notificationTitle, packages-notify.ts).
	switch {
	case isDoorbell(r):
		m.Title = "Someone's at the door · " + name
		m.CategoryID = "doorbell-ring" // "Watch" action; tapping opens the full-screen call
		m.InterruptionLevel = "time-sensitive"
		m.Data["kind"] = "doorbell"
	case isPackage(r):
		m.Title = "Package delivered · " + name
		m.Data["kind"] = "package"
	}
	return m
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func anyIn(have, want []string) bool {
	for _, h := range have {
		if contains(want, h) {
			return true
		}
	}
	return false
}

func uniq(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// thumbnail returns the encrypted inline snapshot for a push, or "" if unavailable.
func (e *engine) thumbnail(ctx context.Context, camera string) string {
	if e.snap == nil || e.secret == "" {
		return ""
	}
	raw, err := e.snap.fetch(ctx, camera, 360)
	if err != nil {
		log.Printf("snapshot for %s: %v", camera, err)
		return ""
	}
	small, err := tinyJPEG(raw)
	if err != nil {
		log.Printf("thumbnail for %s: %v", camera, err)
		return ""
	}
	sealed, err := sealThumb(e.secret, small)
	if err != nil {
		return ""
	}
	return sealed
}
