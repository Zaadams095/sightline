package main

import (
	"context"
	"log"
	"strings"
	"time"

	"github.com/zachadams/sightline/bridge/backend"
	"github.com/zachadams/sightline/bridge/backend/frigate"
)

// healthMonitor polls a system's health and pushes one alert per new problem (camera offline,
// storage nearly full, system not answering), re-arming once it clears.
type healthMonitor struct {
	poll   func(ctx context.Context) (backend.Health, error)
	label  string // "Frigate"
	store  *store
	pusher pusher
	// cameraID maps a native camera ID to the ID devices know it by (nil = unchanged).
	cameraID func(native string) string
	// allow reports whether a device may hear about a camera ("" = system-wide issue).
	allow func(d device, camera string) bool

	active   map[string]bool // issue key -> already notified
	failures int
}

// Frigate wire types, kept under their old names for the tests.
type (
	frigateStats  = frigate.Stats
	frigateConfig = frigate.Config
)

type issue struct {
	key        string
	camera     string
	storagePct int // >0 for storage issues: only devices with a threshold <= this are told
	// text is the notice in a phone's language (i18n.go).
	text func(lang string) (title, body string)
}

// newHealthMonitor watches a Frigate at base (the original bridge behavior).
func newHealthMonitor(base string, s *store, p pusher) *healthMonitor {
	f := frigate.New(backend.Config{ID: "frigate", Kind: "frigate", URL: base})
	return newBackendHealthMonitor(f, s, p)
}

func newBackendHealthMonitor(b backend.Backend, s *store, p pusher) *healthMonitor {
	return &healthMonitor{poll: b.Health, label: b.Label(), store: s, pusher: p, active: map[string]bool{}}
}

func (h *healthMonitor) run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		h.check(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (h *healthMonitor) check(ctx context.Context) {
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	report, err := h.poll(cctx)
	if ctx.Err() != nil {
		return
	}
	h.evaluateHealth(report, err)
}

// evaluate turns one Frigate stats/config poll into notifications.
func (h *healthMonitor) evaluate(stats frigateStats, cfg frigateConfig, pollErr error) {
	h.evaluateHealth(frigate.HealthFrom(stats, cfg), pollErr)
}

// evaluateHealth turns one poll into notifications; split out for tests.
func (h *healthMonitor) evaluateHealth(report backend.Health, pollErr error) {
	var issues []issue
	if pollErr != nil {
		h.failures++
		// Three misses in a row (~3 min) before calling it down, to ride out restarts.
		if h.failures >= 3 {
			label, msg := h.label, pollErr.Error()
			issues = append(issues, issue{key: "down", text: func(lang string) (string, string) {
				return tr(lang, "health.down.title", label), tr(lang, "health.down.body", msg)
			}})
		}
	} else {
		h.failures = 0
		for _, native := range report.Offline {
			cam := native
			if h.cameraID != nil {
				cam = h.cameraID(native)
			}
			issues = append(issues, issue{key: "offline:" + cam, camera: cam, text: func(lang string) (string, string) {
				return tr(lang, "health.offline.title", native), tr(lang, "health.offline.body")
			}})
		}
		for _, s := range report.Storage {
			if s.Problem != "" {
				// Always worth a push when health alerts are on, whatever the fullness threshold.
				issues = append(issues, issue{key: "disk:" + s.Path, text: func(lang string) (string, string) {
					return tr(lang, "health.disk.title", s.Path), tr(lang, "health.disk.body", s.Problem)
				}})
				continue
			}
			issues = append(issues, issue{key: "storage:" + s.Path, storagePct: s.UsedPct, text: func(lang string) (string, string) {
				return tr(lang, "health.storage.title", s.UsedPct), tr(lang, "health.storage.body", decimalText(lang, s.FreeGB, 1), s.Path)
			}})
		}
	}

	now := map[string]bool{}
	var msgs []pushMessage
	for _, is := range issues {
		for _, d := range h.store.all() {
			if !d.Health.Enabled || (is.storagePct > 0 && is.storagePct < max(1, d.Health.StoragePct)) {
				continue
			}
			if h.allow != nil && !h.allow(d, is.camera) {
				continue
			}
			now[is.key] = true
			if h.active[is.key] {
				continue
			}
			lang := normLang(d.Lang)
			title, body := is.text(lang)
			if cam, ok := strings.CutPrefix(is.key, "offline:"); ok && d.CameraNames[cam] != "" {
				title = tr(lang, "health.offline.title", d.CameraNames[cam])
			}
			msgs = append(msgs, forDevice(d, pushMessage{To: d.PushToken, Title: title, Body: body, Sound: "default"}, channelHealth))
		}
	}
	h.active = now
	if len(msgs) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := h.pusher.send(ctx, msgs); err != nil {
		log.Printf("health push failed: %v", err)
	}
}
