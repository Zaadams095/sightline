package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"
)

// healthMonitor polls Frigate's internal API and pushes one alert per new problem
// (camera offline, storage nearly full, Frigate not answering), re-arming once it clears.
type healthMonitor struct {
	base   string
	store  *store
	pusher pusher
	client *http.Client

	active   map[string]bool // issue key -> already notified
	failures int
}

type frigateStats struct {
	Cameras map[string]struct {
		CameraFPS float64 `json:"camera_fps"`
	} `json:"cameras"`
	Service struct {
		Storage map[string]struct {
			Total float64 `json:"total"`
			Used  float64 `json:"used"`
			Free  float64 `json:"free"`
		} `json:"storage"`
	} `json:"service"`
}

type frigateConfig struct {
	Cameras map[string]struct {
		Enabled *bool `json:"enabled"`
	} `json:"cameras"`
}

type issue struct {
	key, title, body string
	storagePct       int // >0 for storage issues: only devices with a threshold <= this are told
}

func newHealthMonitor(base string, s *store, p pusher) *healthMonitor {
	return &healthMonitor{base: base, store: s, pusher: p, client: &http.Client{Timeout: 10 * time.Second}, active: map[string]bool{}}
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

func (h *healthMonitor) getJSON(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.base+path, nil)
	if err != nil {
		return err
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (h *healthMonitor) check(ctx context.Context) {
	var stats frigateStats
	var cfg frigateConfig
	err := h.getJSON(ctx, "/api/stats", &stats)
	if err == nil {
		err = h.getJSON(ctx, "/api/config", &cfg)
	}
	h.evaluate(stats, cfg, err)
}

// evaluate turns one poll into notifications; split out for tests.
func (h *healthMonitor) evaluate(stats frigateStats, cfg frigateConfig, pollErr error) {
	var issues []issue
	if pollErr != nil {
		h.failures++
		// Three misses in a row (~3 min) before calling it down, to ride out restarts.
		if h.failures >= 3 {
			issues = append(issues, issue{key: "down", title: "Frigate isn't responding", body: pollErr.Error()})
		}
	} else {
		h.failures = 0
		names := make([]string, 0, len(stats.Cameras))
		for name := range stats.Cameras {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			c := cfg.Cameras[name]
			if c.Enabled != nil && !*c.Enabled {
				continue
			}
			if stats.Cameras[name].CameraFPS == 0 {
				issues = append(issues, issue{key: "offline:" + name, title: name + " is offline", body: "No video from this camera."})
			}
		}
		for path, s := range stats.Service.Storage {
			if s.Total <= 0 || !strings.HasPrefix(path, "/media/frigate") {
				continue
			}
			pct := int(s.Used / s.Total * 100)
			issues = append(issues, issue{
				key: "storage:" + path, storagePct: pct,
				title: fmt.Sprintf("Recorder storage is %d%% full", pct),
				body:  fmt.Sprintf("%.1f GB free on %s.", s.Free/1024, path),
			})
		}
	}

	now := map[string]bool{}
	var msgs []pushMessage
	for _, is := range issues {
		for _, d := range h.store.all() {
			if !d.Health.Enabled || (is.storagePct > 0 && is.storagePct < max(1, d.Health.StoragePct)) {
				continue
			}
			now[is.key] = true
			if h.active[is.key] {
				continue
			}
			title := is.title
			if cam, ok := strings.CutPrefix(is.key, "offline:"); ok && d.CameraNames[cam] != "" {
				title = d.CameraNames[cam] + " is offline"
			}
			msgs = append(msgs, pushMessage{To: d.PushToken, Title: title, Body: is.body, Sound: "default"})
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
