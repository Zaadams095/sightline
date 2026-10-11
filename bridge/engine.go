package main

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
	"github.com/zachadams/sightline/bridge/backend/frigate"
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
	Rules       map[string]rule   `json:"rules"` // keyed by camera ID
	CameraNames map[string]string `json:"cameraNames"`
	Masks       map[string][][]pt `json:"masks"`
	DetectSizes map[string]size   `json:"detectSizes"`
	QuietHours  quietHours        `json:"quietHours"`
	CooldownSec int64             `json:"cooldownSec"`
	// Recognized names (sub-labels) that never alert; unrecognized objects always do.
	QuietFor []string `json:"quietFor"`
	// Camera ID -> unix seconds until which alerts from it are muted.
	Snoozed map[string]int64 `json:"snoozed"`
	Health  healthPrefs      `json:"health"`
	// Home/Away (from the phone's geofence): while home, only these cameras alert.
	AtHome        bool     `json:"atHome"`
	AlertWhenHome []string `json:"alertWhenHome"`
	UpdatedAt     int64    `json:"updatedAt"`

	// Hub: the grant this phone registered with ("" = legacy BRIDGE_SECRET pairing, which is
	// owner-equivalent). Alerts are limited to what the grant can see.
	GrantID string `json:"grantId,omitempty"`
	// Hub: per-phone key for the encrypted inline thumbnail (legacy pairings use BRIDGE_SECRET).
	ThumbKey string `json:"thumbKey,omitempty"`
}

type healthPrefs struct {
	Enabled    bool `json:"enabled"`
	StoragePct int  `json:"storagePct"`
}

// Frigate's MQTT wire types, used by the legacy entry points below and the tests.
type (
	review        = frigate.Review
	reviewData    = frigate.ReviewData
	reviewMessage = frigate.ReviewMessage
)

type engine struct {
	store  *store
	pusher pusher
	secret string
	// snapshot fetches a camera's current frame for the inline thumbnail (nil = none).
	snapshot func(ctx context.Context, camera string, height int) ([]byte, error)
	// allow reports whether a device may be alerted about a camera (nil = everyone).
	allow func(d device, camera string) bool

	pointsMu sync.Mutex
	points   map[string][][2]float64 // object id -> pixel foot positions seen so far
	seenAt   map[string]time.Time

	mu       sync.Mutex
	notified map[string]bool             // deviceID|eventID already pushed
	lastCam  map[string]map[string]int64 // deviceID -> camera -> last push (unix)
}

func newEngine(s *store, p pusher) *engine {
	return &engine{
		store: s, pusher: p,
		notified: map[string]bool{}, lastCam: map[string]map[string]int64{},
		points: map[string][][2]float64{}, seenAt: map[string]time.Time{},
	}
}

// handleEvent records an object position from a raw frigate/events message.
func (e *engine) handleEvent(payload []byte) {
	if id, x, y, ok := frigate.ParseObjectMessage(payload); ok {
		e.OnPosition(id, x, y)
	}
}

// handle processes a raw frigate/reviews message.
func (e *engine) handle(payload []byte) {
	m, ok, err := frigate.ParseReviewMessage(payload)
	if err != nil {
		log.Printf("bad review message: %v", err)
		return
	}
	if ok {
		e.OnEvent(m.After.Event())
	}
}

// OnPosition records where each tracked object's feet were, for alert masks (backend.Sink).
func (e *engine) OnPosition(id string, x, y float64) {
	e.pointsMu.Lock()
	defer e.pointsMu.Unlock()
	e.points[id] = append(e.points[id], [2]float64{x, y})
	e.seenAt[id] = time.Now()
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

// masked reports whether every known position of the event's objects is inside a mask.
func (e *engine) masked(d device, r backend.Event) bool {
	polys := d.Masks[r.Camera]
	sz, ok := d.DetectSizes[r.Camera]
	if len(polys) == 0 || !ok || sz.Width == 0 || sz.Height == 0 {
		return false
	}
	e.pointsMu.Lock()
	defer e.pointsMu.Unlock()
	var pts []pt
	for _, id := range r.Detections {
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

// OnEvent applies every device's rules to a new or updated event and pushes (backend.Sink).
func (e *engine) OnEvent(r backend.Event) {
	now := time.Now()

	var msgs []pushMessage
	var keys []string
	e.mu.Lock()
	for _, d := range e.store.all() {
		key := d.ID + "|" + r.ID
		if e.notified[key] {
			continue
		}
		if e.allow != nil && !e.allow(d, r.Camera) {
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
		if now.Unix()-cams[r.Camera] < d.CooldownSec {
			continue
		}
		cams[r.Camera] = now.Unix()
		e.notified[key] = true
		msgs = append(msgs, buildMessage(d, r))
		keys = append(keys, e.thumbKey(d))
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
	if small := e.thumbnail(ctx, r.Camera, keys); small != nil {
		for i := range msgs {
			if keys[i] == "" {
				continue
			}
			if sealed, err := sealThumb(keys[i], small); err == nil {
				msgs[i].Data["thumb"] = sealed
			}
		}
	}
	if err := e.pusher.send(ctx, msgs); err != nil {
		log.Printf("push failed: %v", err)
	}
}

// thumbKey is the secret a device decrypts inline thumbnails with ("" = no thumbnail).
func (e *engine) thumbKey(d device) string {
	if d.ThumbKey != "" {
		return d.ThumbKey
	}
	if d.GrantID == "" {
		return e.secret
	}
	return ""
}

func shouldNotify(d device, r backend.Event, now time.Time) bool {
	ru, ok := d.Rules[r.Camera]
	if !ok {
		ru = d.DefaultRule
	}
	if !ru.Enabled {
		return false
	}
	if len(ru.Severities) > 0 && !contains(ru.Severities, r.Severity) {
		return false
	}
	if len(ru.Objects) > 0 && !anyIn(r.Objects, ru.Objects) {
		return false
	}
	if len(ru.Zones) > 0 && !anyIn(r.Zones, ru.Zones) {
		return false
	}
	if d.Snoozed[r.Camera] > now.Unix() {
		return false
	}
	if d.AtHome && !contains(d.AlertWhenHome, r.Camera) {
		return false
	}
	if onlyKnown(r.SubLabels, d.QuietFor) {
		return false
	}
	return !inQuietHours(d, now)
}

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

func buildMessage(d device, r backend.Event) pushMessage {
	name := d.CameraNames[r.Camera]
	if name == "" {
		name = r.Camera
	}
	// Same as the app's titleFor: recognized names first, else object labels.
	what := "Motion"
	objs := uniq(r.Objects)
	if names := uniq(r.SubLabels); len(names) > 0 {
		what = strings.Join(names, " & ")
	} else if len(objs) > 0 {
		for i, o := range objs {
			objs[i] = strings.ToUpper(o[:1]) + strings.ReplaceAll(o[1:], "_", " ")
		}
		what = strings.Join(objs, " & ")
	}
	body := ""
	if len(r.Zones) > 0 {
		body = "In " + strings.ReplaceAll(strings.Join(r.Zones, ", "), "_", " ")
	}
	return pushMessage{
		To:       d.PushToken,
		Title:    what + " · " + name,
		Body:     body,
		Sound:    "default",
		Priority: "high",
		ThreadID: d.SystemID + ":" + r.Camera,
		Data: map[string]string{
			"systemId": d.SystemID,
			"cameraId": r.Camera,
			"start":    fmt.Sprintf("%d", int64(r.Start)-5),
			"reviewId": r.ID,
		},
		MutableContent: true,
		CategoryID:     "camera-alert", // long-press snooze actions, registered by the app
	}
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

// thumbnail returns the tiny JPEG for a push, or nil if no device wants one or it failed.
func (e *engine) thumbnail(ctx context.Context, camera string, keys []string) []byte {
	want := false
	for _, k := range keys {
		want = want || k != ""
	}
	if e.snapshot == nil || !want {
		return nil
	}
	raw, err := e.snapshot(ctx, camera, 360)
	if err != nil {
		log.Printf("snapshot for %s: %v", camera, err)
		return nil
	}
	small, err := tinyJPEG(raw)
	if err != nil {
		log.Printf("thumbnail for %s: %v", camera, err)
		return nil
	}
	return small
}
